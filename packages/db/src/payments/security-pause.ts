import {
  BANK_FEED_PAUSE_LOCK_KEY,
  SECURITY_PAUSE_AUDIT,
  SECURITY_PAUSE_REASONS,
  type SecurityPauseReason,
} from '@repo/shared';
import { Prisma } from '../generated/prisma/client.js';
import { assertInTransaction, type Tx } from '../ledger/ledger.js';

/**
 * The all-cards security pause (D-52 r2, review M-A / I-A / I-B), one predicate for the worker
 * (which writes it) and the API (card:add reads it). A security pause of a card is OPEN while the
 * card has a SYSTEM `CARD_PAUSE` AuditLog row with a security reason (SECURITY_PAUSE_REASONS) and
 * no `CARD_RESUME` row after it; only the owner's card:resume writes that row. A chain-break pause
 * (no such row) is not a security pause. `>` on createdAt: a resume in the very same millisecond
 * does not count (fail closed).
 */
const REASONS = Prisma.join([...SECURITY_PAUSE_REASONS]);

function openPauseOf(card: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "AuditLog" p
    WHERE p."targetType" = ${SECURITY_PAUSE_AUDIT.targetType} AND p."targetId" = ${card}
      AND p."actorType" = ${SECURITY_PAUSE_AUDIT.actorType}
      AND p."action" = ${SECURITY_PAUSE_AUDIT.action} AND p."reason" IN (${REASONS})
      AND NOT EXISTS (
        SELECT 1 FROM "AuditLog" r
        WHERE r."targetType" = p."targetType" AND r."targetId" = p."targetId"
          AND r."action" = 'CARD_RESUME' AND r."createdAt" > p."createdAt"))`;
}

/** The lock card:add and the pause's final re-read share (never with a card lock in one tx). */
export async function lockBankFeedPause(tx: Tx): Promise<void> {
  assertInTransaction(tx, 'lockBankFeedPause');
  await tx.$queryRaw`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtext(${BANK_FEED_PAUSE_LOCK_KEY}))`;
}

export interface OpenSecurityPause {
  readonly auditId: string;
  readonly cardId: string;
  readonly reason: SecurityPauseReason;
}

/** The newest open security pause on a live (not RETIRED) card, or null. */
export async function openSecurityPause(db: Tx): Promise<OpenSecurityPause | null> {
  const rows = await db.$queryRaw<{ auditId: string; cardId: string; reason: string }[]>`
    SELECT p.id AS "auditId", p."targetId" AS "cardId", p."reason" AS "reason"
    FROM "AuditLog" p JOIN "TopupCard" c ON c.id = p."targetId"
    WHERE c.status <> 'RETIRED'
      AND p."targetType" = ${SECURITY_PAUSE_AUDIT.targetType}
      AND p."actorType" = ${SECURITY_PAUSE_AUDIT.actorType}
      AND p."action" = ${SECURITY_PAUSE_AUDIT.action} AND p."reason" IN (${REASONS})
      AND NOT EXISTS (
        SELECT 1 FROM "AuditLog" r
        WHERE r."targetType" = p."targetType" AND r."targetId" = p."targetId"
          AND r."action" = 'CARD_RESUME' AND r."createdAt" > p."createdAt")
    ORDER BY p."createdAt" DESC, p.id DESC
    LIMIT 1`;
  const row = rows[0];
  const reason = SECURITY_PAUSE_REASONS.find((r) => r === row?.reason);
  return row === undefined || reason === undefined ? null : { ...row, reason };
}

/** Whether this card is paused under an open security pause (re-read under its card lock). */
export async function hasOpenSecurityPause(db: Tx, cardId: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ open: boolean }[]>`
    SELECT (c."autoCreditPaused" AND ${openPauseOf(Prisma.sql`c.id`)}) AS "open"
    FROM "TopupCard" c WHERE c.id = ${cardId}`;
  return rows[0]?.open === true;
}

/**
 * Live (not RETIRED, VERIFYING included) cards that still need the security pause: auto-credit
 * on, or paused for another reason only (a chain break). Ordered by id.
 */
export async function liveCardsWithoutSecurityPause(db: Tx): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT c.id FROM "TopupCard" c
    WHERE c.status <> 'RETIRED' AND NOT (c."autoCreditPaused" AND ${openPauseOf(Prisma.sql`c.id`)})
    ORDER BY c.id`;
  return rows.map((row) => row.id);
}
