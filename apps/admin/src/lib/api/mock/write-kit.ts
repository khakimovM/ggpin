// The frame of every mock write route, so they all behave like the API's admin writes (docs/04
// «Idempotency-Key», «Tasdiq kodi»): the key and body are checked with the shared schemas, a
// replay of the same key and body returns the first result with `applied: false`, another body
// is 409, a 4xx writes nothing, the audit id is derived from the key, and the answer is parsed
// with the endpoint's response schema before it leaves.
import {
  AdminConfirmationBodySchema,
  IdempotencyKeySchema,
  adminConfirmationCanonical,
  type AdminConfirmationBody,
  type AdminOtpAnswer,
  type AdminPermission,
} from '@repo/shared';
import type { z } from 'zod';
import { expectedAuditId } from '../../idempotency-outcome';
import { MOCK_ATTEMPTS, MOCK_WRONG_CODE, adminOf } from './fixtures';
import { journalAudit, readJournal, updateJournal, type Journal } from './mock-journal';
import { readMockState, writeMockState } from './mock-state';
import { fail, type MockReply, type MockRequest, type MockRoute } from './router';

export interface WriteContext<B> {
  params: Readonly<Record<string, string>>;
  body: B;
  key: string;
  admin: { id: string; name: string };
  auditId: string;
  now: Date;
  /** A draft: kept only when the route answers 2xx. */
  journal: Journal;
  /** Adds the action's audit row to the draft (actor = the mock admin). */
  audit: (row: {
    action: string;
    targetType: string;
    targetId: string;
    reason: string | null;
  }) => void;
}

export interface WriteSpec<S extends z.ZodType> {
  pattern: string;
  permission: AdminPermission;
  body: S;
  response: z.ZodType;
  run: (context: WriteContext<z.infer<S>>) => MockReply;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === 'object' && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : inner,
  );
}

// The body hash ignores the code (a resend with a new code is the same action, docs/04).
function bodyHash(body: unknown): string {
  if (typeof body !== 'object' || body === null) return canonical(body);
  const { otp: _otp, ...rest } = body as Record<string, unknown>;
  return canonical(rest);
}

const invalid = (path: string, code = 'INVALID') =>
  fail('VALIDATION_ERROR', { fields: [{ path, code }] });

function takeWriteScenario() {
  const scenario = readMockState().writeScenario;
  if (scenario !== 'ok') writeMockState({ writeScenario: 'ok' });
  return scenario;
}

export function writeRoute<S extends z.ZodType>(spec: WriteSpec<S>): MockRoute {
  return {
    method: 'POST',
    pattern: spec.pattern,
    permission: spec.permission,
    handler: async (request: MockRequest) => {
      const key = request.headers['idempotency-key'] ?? '';
      if (!IdempotencyKeySchema.safeParse(key).success) return invalid('Idempotency-Key');
      const parsed = spec.body.safeParse(request.body);
      if (!parsed.success) return invalid(String(parsed.error.issues[0]?.path[0] ?? 'body'));
      const admin = adminOf(readMockState().role);
      const replayKey = `${admin.id}|${key}`;
      const hash = bodyHash(request.body);
      const replay = readJournal().replays[replayKey];
      if (replay !== undefined) {
        if (replay.hash !== hash) return fail('IDEMPOTENCY_CONFLICT');
        const first = replay.data as Record<string, unknown>;
        return { status: replay.status, data: spec.response.parse({ ...first, applied: false }) };
      }
      const scenario = takeWriteScenario();
      if (scenario === 'conflict') return fail('IDEMPOTENCY_CONFLICT');
      if (scenario === 'fail500') return fail('INTERNAL_ERROR');
      const auditId = await expectedAuditId(admin.id, key);
      const draft = structuredClone(readJournal());
      const reply = spec.run({
        params: request.params,
        body: parsed.data,
        key,
        // Only id + name: an author / actor object is strict in the shared schemas.
        admin: { id: admin.id, name: admin.name },
        auditId,
        now: request.now,
        journal: draft,
        audit: (row) =>
          journalAudit(
            {
              id: auditId,
              createdAt: request.now.toISOString(),
              actor: { type: 'ADMIN', id: admin.id, name: admin.name },
              before: null,
              after: null,
              ip: '127.0.0.x',
              ...row,
            },
            draft,
          ),
      });
      if (reply.status >= 300) return reply;
      const data = spec.response.parse(reply.data) as Record<string, unknown>;
      updateJournal((journal) => {
        Object.assign(journal, draft);
        if (data.auditId !== null)
          journal.replays[replayKey] = { hash, status: reply.status, data };
      });
      if (scenario === 'applyThen500') return fail('INTERNAL_ERROR');
      if (scenario === 'applyThenCodeExpired') return fail('CODE_EXPIRED');
      return { status: reply.status, data };
    },
  };
}

/**
 * The step-up check of a mock action: a code when `required`, issued by the confirm route for
 * exactly `confirmation`, by this admin; "000000" is wrong; the re-typed amount must match.
 * Consumes the challenge in the draft. Null when the action may go on.
 */
export function checkCode(
  context: WriteContext<{
    otp?: AdminOtpAnswer | undefined;
    confirmAmountTiyin?: string | undefined;
  }>,
  rule: { required: boolean; confirmation: AdminConfirmationBody; amountTiyin?: string },
): MockReply | null {
  const otp = context.body.otp;
  if (otp === undefined) return rule.required ? invalid('otp', 'OTP_REQUIRED') : null;
  const challenge = context.journal.challenges[otp.challengeId];
  if (challenge === undefined || challenge.adminId !== context.admin.id)
    return fail('CODE_EXPIRED');
  if (
    otp.code === MOCK_WRONG_CODE ||
    challenge.canonical !==
      adminConfirmationCanonical(AdminConfirmationBodySchema.parse(rule.confirmation))
  ) {
    return fail('CODE_INVALID', { attemptsLeft: MOCK_ATTEMPTS - 1 });
  }
  if (rule.amountTiyin !== undefined && context.body.confirmAmountTiyin !== rule.amountTiyin) {
    return invalid('confirmAmountTiyin', 'AMOUNT_MISMATCH');
  }
  delete context.journal.challenges[otp.challengeId];
  return null;
}

export { invalid as fieldError };
