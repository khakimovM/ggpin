// The dev mock of `POST /admin/write-keys/void` (docs/04 «Kalitni bekor qilish», 9-B SA-1): the
// key's replay decides, like the API's primary key. A committed write → APPLIED with its own audit
// row; otherwise a tombstone (an IDEMPOTENCY_VOID audit row under the key's audit id) → VOIDED,
// and every later write with the key is 409 (write-kit.ts). Body and answer use the shared schemas.
import {
  AdminWriteKeyVoidBodySchema,
  AdminWriteKeyVoidResponseSchema,
  IDEMPOTENCY_VOID_ACTION,
  permissionsFor,
  type AdminKeyedWritePermission,
} from '@repo/shared';
import { expectedAuditId } from '../../idempotency-outcome';
import { adminOf } from './fixtures';
import { journalAudit, readJournal, updateJournal } from './mock-journal';
import { readMockState, writeMockState } from './mock-state';
import { fail, ok, type MockRequest, type MockRoute } from './router';
import { fieldError } from './write-kit';

/** `AuditLog.targetType` of a tombstone by the voided action's area (the API names it per key). */
const TARGET_TYPE: Readonly<Record<string, string>> = {
  orders: 'Order',
  users: 'User',
  payments: 'Payment',
  cards: 'TopupCard',
  catalog: 'Product',
  fx: 'FxRate',
  admins: 'AdminUser',
  sessions: 'AdminSession',
  queues: 'QueueJob',
};

function takeVoidScenario() {
  const scenario = readMockState().voidScenario;
  if (scenario !== 'ok') writeMockState({ voidScenario: 'ok' });
  return scenario;
}

function targetTypeOf(action: AdminKeyedWritePermission): string {
  return TARGET_TYPE[action.slice(0, action.indexOf('.'))] ?? 'Unknown';
}

async function voidKey(request: MockRequest) {
  const parsed = AdminWriteKeyVoidBodySchema.safeParse(request.body);
  if (!parsed.success) return fieldError(String(parsed.error.issues[0]?.path[0] ?? 'body'));
  const { idempotencyKey, action, targetId } = parsed.data;
  const state = readMockState();
  // docs/04: a key of an action the admin's role cannot do now is the API's 404, nothing written.
  if (!permissionsFor(state.role).includes(action)) return fail('NOT_FOUND');
  const scenario = takeVoidScenario();
  if (scenario === 'deadline503') return fail('ADMIN_DEADLINE_EXCEEDED');
  if (scenario === 'notFound') return fail('NOT_FOUND');
  const admin = adminOf(state.role);
  const replayKey = `${admin.id}|${idempotencyKey}`;
  const auditId = await expectedAuditId(admin.id, idempotencyKey);
  const journal = readJournal();
  if (journal.replays[replayKey] !== undefined) {
    const row = journal.audit.find((entry) => entry.id === auditId);
    if (row === undefined) return fail('INTERNAL_ERROR');
    return ok(
      AdminWriteKeyVoidResponseSchema.parse({
        status: 'APPLIED',
        auditId,
        action: row.action,
        at: row.createdAt,
      }),
    );
  }
  const at = journal.voided[replayKey]?.at ?? request.now.toISOString();
  updateJournal((draft) => {
    if (draft.voided[replayKey] !== undefined) return;
    draft.voided[replayKey] = { auditId, at };
    journalAudit(
      {
        id: auditId,
        createdAt: at,
        actor: { type: 'ADMIN', id: admin.id, name: admin.name },
        action: IDEMPOTENCY_VOID_ACTION,
        targetType: targetTypeOf(action),
        targetId,
        before: null,
        after: { voidedAction: action, adminRole: state.role },
        reason: null,
        ip: '127.0.0.x',
      },
      draft,
    );
  });
  return ok(AdminWriteKeyVoidResponseSchema.parse({ status: 'VOIDED', auditId, at }));
}

export const writeKeyRoutes: readonly MockRoute[] = [
  {
    method: 'POST',
    pattern: '/admin/write-keys/void',
    permission: 'writeKeys.void',
    handler: voidKey,
  },
];
