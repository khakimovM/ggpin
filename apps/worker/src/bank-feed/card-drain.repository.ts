import { Injectable } from '@nestjs/common';
import type { Tx } from '@repo/db';
import { assertCardTransition, type TopupCardStatus } from '@repo/shared';
import { StaleCardError } from './match-writes.repository';

/** The SYSTEM audit row of one drained card (the owner's `cardDrained` alert names the card). */
export const CARD_DRAIN_AUDIT = {
  actorType: 'SYSTEM',
  action: 'CARD_RETIRE_DRAINED',
  targetType: 'TopupCard',
  reason: 'RESERVATIONS_ENDED',
} as const;

/**
 * The reads and writes of the DRAINING -> RETIRED sweep (CardDrainService). A request still
 * keeps the card open while `reservedUntil >= horizon`, whatever its status (PENDING, EXPIRED,
 * CANCELLED, PAID: a paid one is held until `paidAt + grace`, D-37 (2)). `>=`, not `>`: a message
 * stored exactly LATE_STORED_AFTER_MS after its date is not "late" (`isLateStored` is strict), so
 * the card must still be open at that very millisecond. The horizon (now - LATE_STORED_AFTER_MS,
 * chosen by the service) is earlier
 * than the allocator's `now` on purpose: the matcher takes a request by the message's Telegram
 * date (`reservedUntil >= tgDate`), so a payment made in time but stored a little late must still
 * find the card live.
 */
@Injectable()
export class CardDrainRepository {
  /** DRAINING cards with no live reservation: candidates only, re-checked under the card lock. */
  async drainedCandidates(db: Tx, horizon: Date): Promise<string[]> {
    const rows = await db.topupCard.findMany({
      where: { status: 'DRAINING', intents: { none: { reservedUntil: { gte: horizon } } } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => row.id);
  }

  async statusOf(tx: Tx, cardId: string): Promise<TopupCardStatus | null> {
    const card = await tx.topupCard.findUnique({ where: { id: cardId }, select: { status: true } });
    return card?.status ?? null;
  }

  async hasLiveReservation(tx: Tx, cardId: string, horizon: Date): Promise<boolean> {
    const row = await tx.paymentIntent.findFirst({
      where: { cardId, reservedUntil: { gte: horizon } },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * A stored message on the card without a decision yet: it may be the payment of a request
   * that was still reserved when it arrived. Retiring now would turn its credit into a
   * CARD_RETIRED review, so the card waits until the matcher (or the orphan fallback) decides.
   */
  async hasUndecidedMessage(tx: Tx, cardId: string): Promise<boolean> {
    const row = await tx.bankMessage.findFirst({
      where: { cardId, outcome: null },
      select: { id: true },
    });
    return row !== null;
  }

  /** DRAINING -> RETIRED with `retiredAt` (TopupCard_retired_check) and its audit row. */
  async retire(tx: Tx, cardId: string, now: Date): Promise<string> {
    assertCardTransition('DRAINING', 'RETIRED');
    const { count } = await tx.topupCard.updateMany({
      where: { id: cardId, status: 'DRAINING' },
      data: { status: 'RETIRED', retiredAt: now },
    });
    if (count !== 1) throw new StaleCardError(cardId);
    const audit = await tx.auditLog.create({
      data: {
        ...CARD_DRAIN_AUDIT,
        actorId: null,
        ip: null,
        targetId: cardId,
        before: { status: 'DRAINING' },
        after: { status: 'RETIRED', retiredAt: now.toISOString() },
      },
      select: { id: true },
    });
    return audit.id;
  }

  /**
   * Cards this sweep retired since `since` (by their audit rows): their `cardDrained` alert is
   * queued again on every run of that window, so an alert lost after the commit (Redis down) is
   * not lost for good. The notify job id is stable per card, so the owner still gets one.
   */
  async drainedSince(db: Tx, since: Date): Promise<string[]> {
    const rows = await db.auditLog.findMany({
      where: {
        actorType: CARD_DRAIN_AUDIT.actorType,
        action: CARD_DRAIN_AUDIT.action,
        targetType: CARD_DRAIN_AUDIT.targetType,
        createdAt: { gte: since },
      },
      select: { targetId: true },
      orderBy: { createdAt: 'asc' },
    });
    return [...new Set(rows.map((row) => row.targetId))];
  }
}
