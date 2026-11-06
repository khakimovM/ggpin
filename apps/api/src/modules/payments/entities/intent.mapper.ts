import type { TopupCard } from '@repo/db';
import {
  TopupIntentCreatedSchema,
  TopupIntentSchema,
  shortHolderName,
  type TopupCardView,
  type TopupIntent,
  type TopupIntentCreated,
} from '@repo/shared';
import type { IntentWithCard } from '../topup-intents.repository';

// The only places a PaymentIntent row becomes a public shape. Fields are listed one by one so
// the token hash, idempotency key, request hash, reservation and user id never reach the wire,
// and every result is parsed with the shared contract schema (a drift is a 500, not a leak).

/** Our receiving card as its PENDING request's owner sees it: short holder name only. */
export function toCardView(card: TopupCard): TopupCardView {
  return { bank: card.bank, number: card.pan, holderName: shortHolderName(card.holderName) };
}

/** The card is shown only while the request waits for money (docs/04). */
export function cardWhilePending(row: IntentWithCard): TopupCardView | null {
  if (row.status !== 'PENDING') return null;
  if (row.card === null) throw new Error(`P2P intent ${row.id} has no card`);
  return toCardView(row.card);
}

function baseOf(row: IntentWithCard): bigint {
  // A CHECK makes it NOT NULL for P2P_CARD; the repository only returns P2P intents.
  if (row.baseAmountTiyin === null) throw new Error(`P2P intent ${row.id} has no base amount`);
  return row.baseAmountTiyin;
}

export function toTopupIntentCreated(row: IntentWithCard, redirectUrl: string): TopupIntentCreated {
  return TopupIntentCreatedSchema.parse({
    intentId: row.id,
    status: row.status,
    baseAmountTiyin: baseOf(row).toString(),
    payAmountTiyin: row.amountTiyin.toString(),
    card: cardWhilePending(row),
    expiresAt: row.expiresAt.toISOString(),
    redirectUrl,
    currency: 'UZS',
  });
}

export function toTopupIntent(row: IntentWithCard): TopupIntent {
  const paid = row.status === 'PAID';
  return TopupIntentSchema.parse({
    intentId: row.id,
    status: row.status,
    baseAmountTiyin: baseOf(row).toString(),
    payAmountTiyin: row.amountTiyin.toString(),
    card: cardWhilePending(row),
    expiresAt: row.expiresAt.toISOString(),
    paidAt: paid && row.paidAt !== null ? row.paidAt.toISOString() : null,
    // A payment credited to an intent carries exactly the intent's pay amount: the database
    // refuses any other (Payment_consistency_guard, GG004), so the credit IS amountTiyin.
    creditedTiyin: paid ? row.amountTiyin.toString() : null,
    currency: 'UZS',
  });
}
