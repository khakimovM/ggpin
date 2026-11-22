import { Injectable } from '@nestjs/common';
import {
  AdminConfirmationBodySchema,
  type AdminConfirmationBody,
  type AdminOtpAnswer,
  type AdminPermission,
} from '@repo/shared';
import { validationError } from '../../../common/admin/admin-input';
import type { AdminActor, AdminStepUp } from '../../../common/admin/audit-actor';
import { AppError } from '../../../common/exceptions/app-error';
import type { AdminPrincipal } from '../common/admin-request';
import { AdminOtpVerifier } from '../confirm/admin-otp.verifier';
import { adminAuditIdFor, adminRequestHash } from './admin-write-key';
import { adminWriteError } from './admin-write-error';
import { AdminWriteRepository, afterField, type AdminAuditRow } from './admin-write.repository';

export interface AdminWriteSpec<T> {
  readonly principal: AdminPrincipal;
  readonly ip: string | null;
  readonly permission: AdminPermission;
  readonly targetId: string;
  /** The `Idempotency-Key` header (already shape-checked). */
  readonly key: string;
  /** The parsed body; hashed without `otp`. */
  readonly body: object;
  readonly otp?: AdminOtpAnswer | undefined;
  /** The confirmation body this request stands for (docs/04 binding), built from the request. */
  readonly confirmation?: () => unknown;
  /** The first call's answer rebuilt from its audit row and the state now (`applied: false`). */
  readonly replay: (row: AdminAuditRow) => Promise<T>;
}

/**
 * Runs one admin write (docs/04 «Admin»): the replay of the same `Idempotency-Key` is answered
 * BEFORE any state or code check (D-49 pattern, a used code does not break it); then the owner
 * service runs with an ADMIN actor whose audit row id is the key's, so a second write with the
 * same key can only collide with the first (primary key). A refusal re-checks the row: a parallel
 * twin that won is a replay, not an error. Never a 4xx after a commit: the services' after-commit
 * steps are best effort, and a failed read here is a 5xx.
 */
@Injectable()
export class AdminWriteRunner {
  constructor(
    private readonly repo: AdminWriteRepository,
    private readonly otp: AdminOtpVerifier,
  ) {}

  async run<T>(spec: AdminWriteSpec<T>, work: (actor: AdminActor) => Promise<T>): Promise<T> {
    const adminId = spec.principal.admin.id;
    const auditId = adminAuditIdFor(adminId, spec.key);
    const requestHash = adminRequestHash(spec.permission, spec.targetId, spec.body);
    const earlier = await this.repo.findAudit(auditId);
    if (earlier !== null) return this.replayOf(earlier, adminId, requestHash, spec);

    const actor: AdminActor = {
      kind: 'ADMIN',
      adminId,
      sessionId: spec.principal.sessionId,
      ip: spec.ip,
      permission: spec.permission,
      request: { auditId, requestHash },
      ...(spec.otp === undefined ? {} : { stepUp: this.stepUp(spec, spec.otp) }),
    };
    let result: T;
    try {
      result = await work(actor);
    } catch (error) {
      // This call's own row counts as the twin too (C-11): when the work committed and a read
      // AFTER the commit failed (the answer's card or balance, a best-effort step that threw), the
      // answer is the replay of that row, `applied: false` with its auditId, although this very
      // call wrote it. The panel treats `applied: false` + auditId as "done"; nothing is retried
      // and nothing is written twice. Only when the row cannot be read either is it a 5xx.
      const twin = await this.repo.findAudit(auditId).catch(() => null);
      if (twin !== null) return this.replayOf(twin, adminId, requestHash, spec);
      throw adminWriteError(error);
    }
    // A twin with the same key that committed while this one waited on the lock: this call found
    // the work done ("nothing to change"); the answer is the first call's, with its auditId.
    if (notApplied(result)) {
      const twin = await this.repo.findAudit(auditId);
      if (twin !== null) return this.replayOf(twin, adminId, requestHash, spec);
    }
    return result;
  }

  private replayOf<T>(
    row: AdminAuditRow,
    adminId: string,
    requestHash: string,
    spec: AdminWriteSpec<T>,
  ): Promise<T> {
    const same =
      row.actorType === 'ADMIN' &&
      row.actorId === adminId &&
      afterField(row, 'requestHash') === requestHash;
    if (!same) throw new AppError('IDEMPOTENCY_CONFLICT');
    return spec.replay(row);
  }

  // The admin's code, checked against the binding of the body rebuilt from THIS request, the
  // flags the service computed, and this admin and session (docs/04 «Tasdiq kodi»).
  private stepUp<T>(spec: AdminWriteSpec<T>, otp: AdminOtpAnswer): AdminStepUp {
    return {
      verify: async (serverFlags) => {
        const body = this.confirmationBody(spec);
        await this.otp.verify(otp, {
          body,
          serverFlags,
          adminId: spec.principal.admin.id,
          sessionId: spec.principal.sessionId,
        });
      },
    };
  }

  private confirmationBody<T>(spec: AdminWriteSpec<T>): AdminConfirmationBody {
    const parsed = AdminConfirmationBodySchema.safeParse(spec.confirmation?.());
    // A route without a confirmation body never takes a code; a body that does not parse can
    // only be a re-typed amount the schema refuses (zero for an adjustment).
    if (spec.confirmation === undefined) throw validationError('otp', 'OTP_INVALID');
    if (!parsed.success) throw validationError('confirmAmountTiyin', 'AMOUNT_MISMATCH');
    return parsed.data;
  }
}

function notApplied(result: unknown): boolean {
  return (
    typeof result === 'object' && result !== null && 'applied' in result && result.applied === false
  );
}
