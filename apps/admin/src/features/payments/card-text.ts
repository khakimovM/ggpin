import type { AdminCard } from '@repo/shared';
import { formatMajor } from '@repo/shared';

type Translate = (
  key: 'admin.payments.cards.result.cancelledIntents',
  values: { count: number },
) => string;

/** "HUMO •4417": how the card dialogs name a card. */
export function cardLabel(card: Pick<AdminCard, 'bank' | 'last4'>): string {
  return `${card.bank} •${card.last4}`;
}

/**
 * A stored limit as the text a so'm field starts with ("500000000" tiyin → "5000000"): the shared
 * money formatter (BigInt) without grouping, so it parses back to the same tiyin.
 */
export function tiyinAsInput(tiyin: string): string {
  return formatMajor('UZS', BigInt(tiyin));
}

/** The toast's detail line when a card change cancelled pending requests. */
export function cancelledDetail(t: Translate, count: number): string | undefined {
  return count > 0 ? t('admin.payments.cards.result.cancelledIntents', { count }) : undefined;
}
