import { Inject, Injectable } from '@nestjs/common';
import {
  AdminRoleSchema,
  IDEMPOTENCY_VOID_ACTION,
  roleHas,
  type AdminWriteKeyVoidBody,
  type AdminWriteKeyVoidResponse,
} from '@repo/shared';
import { confirmActorInTx } from '../../../common/admin/audit-actor.check';
import type { AdminActor } from '../../../common/admin/audit-actor';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { AppError } from '../../../common/exceptions/app-error';
import type { AdminPrincipal } from '../common/admin-request';
import { adminAuditIdFor, adminRequestHash } from './admin-write-key';
import { VOID_TARGET_TYPES } from './admin-write-void.targets';
import { AdminWriteRepository, type AdminAuditRow } from './admin-write.repository';

/**
 * Longer than the longest admin write transaction (the card path: a 4 s lock wait + 15 s work):
 * the tombstone insert may wait for an in-flight write that already inserted the same audit id.
 * Re-checked once statement_timeout lands (9B-M1).
 */
export const VOID_TX_TIMEOUT_MS = 25_000;

/**
 * `POST /admin/write-keys/void` (docs/04 «Kalitni bekor qilish», 9-B SA-1). The key's audit id
 * (`adminAuditIdFor`, the primary key) is the referee between the void and any earlier request
 * with that key:
 * - that request committed -> its row is there -> APPLIED;
 * - it inserted its row and has not committed -> the insert below waits for it: commit ->
 *   APPLIED, rollback -> the tombstone goes in -> VOIDED;
 * - it has not inserted its row yet -> the tombstone wins; its own insert later fails on the
 *   primary key, its whole transaction rolls back and the runner answers 409 from the tombstone.
 * The id is derived from THIS admin's id, so no admin can void another admin's key.
 */
@Injectable()
export class AdminWriteVoidService {
  constructor(
    private readonly repo: AdminWriteRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async void(
    principal: AdminPrincipal,
    ip: string | null,
    body: AdminWriteKeyVoidBody,
  ): Promise<AdminWriteKeyVoidResponse> {
    const adminId = principal.admin.id;
    const auditId = adminAuditIdFor(adminId, body.idempotencyKey);
    const actor: AdminActor = {
      kind: 'ADMIN',
      adminId,
      sessionId: principal.sessionId,
      ip,
      permission: 'writeKeys.void',
      // The actor type needs a request hash; it is never stored (the tombstone has none, K1).
      request: { auditId, requestHash: adminRequestHash('writeKeys.void', body.targetId, body) },
    };
    const now = this.clock.now();
    const row = await this.repo.transaction(async (tx) => {
      // Still active, the role read now holds `writeKeys.void`, the session still open: else 404.
      const who = await confirmActorInTx(tx, actor, now);
      if (!('adminRole' in who)) throw new AppError('INTERNAL_ERROR'); // an ADMIN actor's answer
      // An admin voids only keys of actions its role (read now) may perform (SA-9B1-3): no
      // tombstone that labels someone else's kind of action. The role before the order context
      // (`roleHas`), as the guard checks the action's own route; else the one 404.
      const role = AdminRoleSchema.safeParse(who.adminRole);
      if (!role.success || !roleHas(role.data, body.action)) throw new AppError('NOT_FOUND');
      await this.repo.insertTombstone(tx, {
        id: auditId,
        actorId: adminId,
        action: IDEMPOTENCY_VOID_ACTION,
        targetType: VOID_TARGET_TYPES[body.action],
        targetId: body.targetId,
        after: { voidedAction: body.action, adminRole: who.adminRole, sessionId: who.sessionId },
        ip,
      });
      // Read in this transaction after the insert: under READ COMMITTED it sees the row the
      // insert waited for, or the tombstone it wrote (now or on an earlier void).
      return this.repo.findAudit(auditId, tx);
    }, VOID_TX_TIMEOUT_MS);
    return answerOf(row, adminId);
  }
}

function answerOf(row: AdminAuditRow | null, adminId: string): AdminWriteKeyVoidResponse {
  // The id is `a` + 31 hex of sha256(adminId|key): no other writer's id can take it, and the
  // audit log is append-only. Anything else is a bug, never an answer.
  if (row === null || row.actorType !== 'ADMIN' || row.actorId !== adminId) {
    throw new AppError('INTERNAL_ERROR');
  }
  const at = row.createdAt.toISOString();
  if (row.action === IDEMPOTENCY_VOID_ACTION) return { status: 'VOIDED', auditId: row.id, at };
  return { status: 'APPLIED', auditId: row.id, action: row.action, at };
}
