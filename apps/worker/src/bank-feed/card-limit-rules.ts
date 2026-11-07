import { CARD_FULL_PERCENT, CARD_NEAR_LIMIT_PERCENT, type CardSums } from '@repo/shared';

// Pure rules of the card-limit check (docs/05 §2, D-45). No I/O.

/** One received CREDIT on the card (any outcome: the bank counts all of them, D-45). */
export interface ReceivedCredit {
  readonly amountTiyin: bigint;
  readonly tgDate: Date;
}

/** Money received on the card BEFORE a message (lower tgMessageId), in cardTotals' windows. */
export interface ReceivedBefore {
  readonly receivedTiyin: bigint;
  readonly receivedMonthTiyin: bigint;
}

/**
 * The card's received sums right after this credit: what arrived before it (by message order,
 * not "everything now minus this", so a replay of an older message is not blurred by money that
 * came later, m-3) plus this credit where cardTotals counts it: in the lifetime sum from
 * `verifiedAt` on, in the month sum also from `monthStart` on. Held amounts play no part (D-45).
 */
export function sumsAfter(
  card: CardSums['card'] & { readonly verifiedAt: Date | null },
  before: ReceivedBefore,
  credit: ReceivedCredit,
  monthStart: Date,
): CardSums {
  const verifiedAt = card.verifiedAt;
  const counts = verifiedAt !== null && credit.tgDate >= verifiedAt;
  const monthFrom = verifiedAt !== null && monthStart < verifiedAt ? verifiedAt : monthStart;
  const inMonth = counts && credit.tgDate >= monthFrom;
  return {
    card,
    receivedTiyin: before.receivedTiyin + (counts ? credit.amountTiyin : 0n),
    receivedMonthTiyin: before.receivedMonthTiyin + (inMonth ? credit.amountTiyin : 0n),
    reservedTiyin: 0n,
  };
}

export type LimitCrossing = 'FULL' | 'NEAR' | null;

/**
 * Which threshold THIS credit crossed: FULL when it took the card from below 100 % to 100 % or
 * more, NEAR when from below 80 % to 80-99 %. A credit on a card already past a line crosses
 * nothing, so later credits do not repeat the owner's alert (L7).
 */
export function limitCrossing(beforePercent: number, afterPercent: number): LimitCrossing {
  if (beforePercent < CARD_FULL_PERCENT && afterPercent >= CARD_FULL_PERCENT) return 'FULL';
  if (
    beforePercent < CARD_NEAR_LIMIT_PERCENT &&
    afterPercent >= CARD_NEAR_LIMIT_PERCENT &&
    afterPercent < CARD_FULL_PERCENT
  ) {
    return 'NEAR';
  }
  return null;
}
