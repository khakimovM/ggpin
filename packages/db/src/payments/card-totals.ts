import { CAPACITY_HELD_STATUSES, capacityHoldWindow, type CardSums } from '@repo/shared';
import type { CardBank, Prisma, TopupCard, TopupCardStatus } from '../generated/prisma/client.js';
import type { Tx } from '../ledger/ledger.js';

/** A card with the three sums its capacity is computed from (docs/05 §2). */
export interface CardTotals extends CardSums {
  readonly card: TopupCard;
}

export interface CardTotalsQuery {
  readonly now: Date;
  /** Start of the current month in Asia/Tashkent (`tashkentMonthStart`). */
  readonly monthStart: Date;
  readonly statuses: readonly TopupCardStatus[];
  /** Only cards whose auto-credit is on (the allocator); the card commands want every card. */
  readonly autoCreditOnly: boolean;
  /** `TOPUP_CAPACITY_HOLD_SEC`: the API and the worker pass the same env value. */
  readonly holdSec: number;
  readonly bank?: CardBank;
  readonly cardId?: string;
}

function sumOf(value: bigint | null | undefined): bigint {
  return value ?? 0n;
}

/**
 * The capacity sums of the matching cards, in ONE place for the API (allocator, card commands,
 * the cardReservedHigh check, the notify renderer) and the worker (80 % alert, ACTIVE -> FULL,
 * the late over-limit alert), so both count exactly the same rows (D-42 (1)). A plain read: the
 * root client works too; a caller that changes a card on the result holds `lockTopupCard`.
 * The `received` sums use the (cardId, tgDate) index of BankMessage.
 */
export async function cardTotals(db: Tx, query: CardTotalsQuery): Promise<CardTotals[]> {
  const cards = await db.topupCard.findMany({
    where: {
      status: { in: [...query.statuses] },
      ...(query.autoCreditOnly ? { autoCreditPaused: false } : {}),
      ...(query.bank === undefined ? {} : { bank: query.bank }),
      ...(query.cardId === undefined ? {} : { id: query.cardId }),
    },
    orderBy: { id: 'asc' },
  });
  if (cards.length === 0) return [];
  const ids = cards.map((card) => card.id);
  const credit = { parseStatus: 'PARSED', direction: 'CREDIT' } as const;
  // A card that was never verified has received nothing that counts (VERIFYING has no
  // verifiedAt; the verification transfer itself counts from verifiedAt on).
  const since = (card: TopupCard, from?: Date): Prisma.BankMessageWhereInput => {
    const verifiedAt = card.verifiedAt ?? query.now;
    const start = from !== undefined && from > verifiedAt ? from : verifiedAt;
    return { cardId: card.id, tgDate: { gte: start } };
  };
  const window = capacityHoldWindow(query.now, query.holdSec);
  const [received, receivedMonth, reserved] = await Promise.all([
    db.bankMessage.groupBy({
      by: ['cardId'],
      where: { ...credit, OR: cards.map((card) => since(card)) },
      _sum: { amountTiyin: true },
    }),
    db.bankMessage.groupBy({
      by: ['cardId'],
      where: { ...credit, OR: cards.map((card) => since(card, query.monthStart)) },
      _sum: { amountTiyin: true },
    }),
    // Unpaid money that may still arrive (D-42 (1); the SQL form of `capacityHoldEnd`): every
    // UNPAID request (PENDING, EXPIRED, CANCELLED) until LEAST(reservedUntil, expiresAt + hold).
    // One predicate for all three, so an overdue PENDING the sweep has not expired yet stops
    // counting at the same moment an EXPIRED one would, and create-and-cancel cannot fill a card
    // for a day. The AMOUNT stays unique for the whole grace (the allocator reads reservedUntil).
    // PAID amounts are not "reserved": their money is already in `received` (the payment's
    // bank message); counting it twice would make a card look full too early.
    // Known overcount, on the safe side (m10): money that arrived for a CANCELLED request and
    // still waits in review is in `received` AND, inside the hold window, here as well.
    db.paymentIntent.groupBy({
      by: ['cardId'],
      where: {
        cardId: { in: ids },
        provider: 'P2P_CARD',
        status: { in: [...CAPACITY_HELD_STATUSES] },
        reservedUntil: { gt: window.reservedUntilAfter },
        expiresAt: { gt: window.expiresAtAfter },
      },
      _sum: { amountTiyin: true },
    }),
  ]);
  const byCard = (rows: { cardId: string | null; _sum: { amountTiyin: bigint | null } }[]) =>
    new Map(rows.map((row) => [row.cardId, sumOf(row._sum.amountTiyin)]));
  const receivedBy = byCard(received);
  const monthBy = byCard(receivedMonth);
  const reservedBy = byCard(reserved);
  return cards.map((card) => ({
    card,
    receivedTiyin: receivedBy.get(card.id) ?? 0n,
    receivedMonthTiyin: monthBy.get(card.id) ?? 0n,
    reservedTiyin: reservedBy.get(card.id) ?? 0n,
  }));
}
