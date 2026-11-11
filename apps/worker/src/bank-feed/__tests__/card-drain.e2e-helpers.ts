import type { PrismaClient } from '@repo/db';
import { notifyJobId } from '@repo/shared';
import { CARD_DRAIN_AUDIT } from '../card-drain.repository';
import { LATE_STORED_AFTER_MS } from '../match-rules';
import {
  GRACE_MS,
  HOUR,
  MINUTE,
  createIntent,
  createUser,
  uniqueAmount,
} from './matcher-e2e.fixtures';

// Shared by the two card-drain e2e files (both on the real ggpin_test DB).

export const LATE = LATE_STORED_AFTER_MS;

export type DrainIntentStatus = 'PENDING' | 'EXPIRED' | 'CANCELLED' | 'PAID';

/** A request on `cardId` whose reservation ends at `reservedUntil` (createIntent's arithmetic). */
export async function intentEndingAt(
  db: PrismaClient,
  cardId: string,
  status: DrainIntentStatus,
  reservedUntil: Date,
) {
  const user = await createUser(db);
  const amountTiyin = uniqueAmount();
  if (status === 'PAID') {
    // Held until paidAt + grace (D-37 (2)), well after expiresAt + grace.
    const paidAt = new Date(reservedUntil.getTime() - GRACE_MS);
    const createdAt = new Date(paidAt.getTime() - 2 * HOUR);
    return createIntent(db, user.id, cardId, { amountTiyin, status, createdAt, paidAt });
  }
  const createdAt = new Date(reservedUntil.getTime() - GRACE_MS - 30 * MINUTE);
  return createIntent(db, user.id, cardId, { amountTiyin, status, createdAt });
}

/** A reservation that ended long enough ago for the sweep (past the late-storage margin). */
export function endedForDrain(now: number = Date.now()): Date {
  return new Date(now - LATE - MINUTE);
}

export const drainAudits = (db: PrismaClient, cardId: string) =>
  db.auditLog.findMany({ where: { action: CARD_DRAIN_AUDIT.action, targetId: cardId } });

export const drainedAlertId = (cardId: string) =>
  notifyJobId({ kind: 'OWNER_ALERT', alert: 'cardDrained', refId: cardId });
