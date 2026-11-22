import { auditIdOf, toAuditColumns } from '../../common/admin/audit-actor';
import type { ActorAfter } from '../../common/admin/audit-actor.check';
import type { Db } from '../../infra/prisma/db';
import type { CardAdminRepository } from './card-admin.repository';
import type { AuditAfter, CardAudit, CardChange, CardJson, Committed } from './card-admin.types';
import type { PaymentsAlerts } from './payments-alerts';

/** The change's AuditLog row (the panel's id is its key's, so a twin collides on the key). */
export function writeCardAudit(
  repo: CardAdminRepository,
  tx: Db,
  row: { cardId: string; audit: CardAudit; who: ActorAfter },
  before: CardJson | null,
  after: AuditAfter,
): Promise<string> {
  const { cardId, audit, who } = row;
  const id = auditIdOf(audit.actor);
  const { action, reason } = audit;
  return repo.createAudit(tx, {
    ...(id === undefined ? {} : { id }),
    ...toAuditColumns(audit.actor),
    action,
    reason,
    targetId: cardId,
    before,
    after: { ...after, ...who },
  });
}

// Best effort (the change is committed): the CLI shows alertQueued=false so the owner knows
// the bot did not hear about it.
export async function raiseCardAlerts(
  alerts: PaymentsAlerts,
  change: Committed<CardChange>,
): Promise<boolean> {
  if (!change.applied || change.auditId === null) return false;
  const jobs = [await alerts.raise('adminAction', change.auditId)];
  if (change.status === 'DRAINING') jobs.push(await alerts.raise('cardDraining', change.cardId));
  return jobs.every((jobId) => jobId !== null);
}
