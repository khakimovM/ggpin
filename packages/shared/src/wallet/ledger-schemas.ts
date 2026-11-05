// GET /me/wallet and GET /me/ledger (docs/04 "Hamyon"), plus the sign rules of ledger rows.
// These describe the `data` payload; the envelope is in the API. Money is a string of minor
// units; the ledger is signed (a purchase is negative).
import { z } from 'zod';
import { ResourceIdSchema, pageQueryShape } from '../common-schemas';
import { SignedTiyinStringSchema, TiyinStringSchema } from '../money-schemas';

export const LEDGER_KINDS = [
  'TOPUP',
  'TOPUP_REVERSAL',
  'PURCHASE',
  'REFUND',
  'REFERRAL_BONUS',
  'REFERRAL_BONUS_REVERSAL',
  'ADJUSTMENT',
] as const;
export const LedgerKindSchema = z.enum(LEDGER_KINDS);
export type LedgerKind = z.infer<typeof LedgerKindSchema>;

export const LEDGER_REF_TYPES = ['PAYMENT', 'ORDER', 'REFERRAL', 'ADMIN_ACTION'] as const;
export type LedgerRefType = (typeof LEDGER_REF_TYPES)[number];

type Sign = 'POSITIVE' | 'NEGATIVE' | 'NONZERO';

// Mirrors the LedgerEntry CHECK constraint (docs/03, "Migratsiya 2"); a DB test and a unit test
// hold the two together. An unknown kind has no entry, so it can never pass.
const SIGN_OF_KIND: Readonly<Record<LedgerKind, Sign>> = Object.freeze({
  TOPUP: 'POSITIVE',
  REFUND: 'POSITIVE',
  REFERRAL_BONUS: 'POSITIVE',
  TOPUP_REVERSAL: 'NEGATIVE',
  PURCHASE: 'NEGATIVE',
  REFERRAL_BONUS_REVERSAL: 'NEGATIVE',
  ADJUSTMENT: 'NONZERO',
});

/** True when `amountTiyin` has the sign the ledger allows for this kind of entry. */
export function isLedgerAmountAllowed(kind: LedgerKind, amountTiyin: bigint): boolean {
  const sign = SIGN_OF_KIND[kind];
  if (sign === 'POSITIVE') return amountTiyin > 0n;
  if (sign === 'NEGATIVE') return amountTiyin < 0n;
  return amountTiyin !== 0n;
}

/** Cashback coins are a non-negative integer count, as a decimal string like money. */
const CoinsStringSchema = TiyinStringSchema; // same BIGINT bound as money (a CoinEntry sum is a BIGINT)

export const WalletResponseSchema = z.strictObject({
  balanceTiyin: SignedTiyinStringSchema, // negative after a reversal of spent money
  coins: CoinsStringSchema,
  currency: z.literal('UZS'),
});
export type WalletResponse = z.infer<typeof WalletResponseSchema>;

export const LedgerQuerySchema = z.strictObject({
  kind: LedgerKindSchema.optional(),
  ...pageQueryShape,
});
export type LedgerQuery = z.infer<typeof LedgerQuerySchema>;

export const LedgerItemSchema = z.strictObject({
  id: ResourceIdSchema,
  kind: LedgerKindSchema,
  amountTiyin: SignedTiyinStringSchema,
  createdAt: z.iso.datetime(),
  /** Set when the entry came from an order (`refType=ORDER`), else null. */
  orderId: ResourceIdSchema.nullable(),
  /** Set when the entry came from a payment (`refType=PAYMENT`), else null. */
  paymentId: ResourceIdSchema.nullable(),
});
export type LedgerItem = z.infer<typeof LedgerItemSchema>;
