import {
  TOPUP_DEFAULTS,
  tiyinToSom,
  type CardBank,
  type PaymentMethodsResponse,
} from '@repo/shared';

/**
 * The limits the form works with, in whole so'm as digit strings (what `MoneyInput` speaks). They
 * come from `GET /payments/methods` and nowhere else: the client hard-codes no minimum, maximum or
 * step. The server still checks everything (`422 TOPUP_AMOUNT_OUT_OF_RANGE`); the form only tells
 * the visitor early.
 */
export interface TopupLimits {
  minSom: string;
  maxSom: string;
  stepSom: string;
  /** The banks that have a card with room right now. */
  banks: readonly CardBank[];
}

/** The P2P card method, or null when it is not offered at all (the "temporarily unavailable" screen). */
export function limitsOf(methods: PaymentMethodsResponse): TopupLimits | null {
  const method = methods.find((item) => item.code === 'P2P_CARD');
  if (method === undefined || !method.available) return null;
  const banks = method.banks.filter((item) => item.available).map((item) => item.bank);
  if (banks.length === 0) return null;
  return {
    minSom: tiyinToSom(BigInt(method.minTiyin)),
    maxSom: tiyinToSom(BigInt(method.maxTiyin)),
    stepSom: tiyinToSom(BigInt(method.stepTiyin)),
    banks,
  };
}

export type AmountProblem = 'min' | 'max' | 'step';

/** What is wrong with the typed amount (digits of whole so'm), if anything. Empty is not an error. */
export function amountProblem(digits: string, limits: TopupLimits): AmountProblem | null {
  if (digits === '') return null;
  const amount = BigInt(digits);
  if (amount < BigInt(limits.minSom)) return 'min';
  if (amount > BigInt(limits.maxSom)) return 'max';
  return amount % BigInt(limits.stepSom) === 0n ? null : 'step';
}

/** The quick amounts of the design (shared constants), kept to those the limits allow. */
export function quickAmounts(limits: TopupLimits): string[] {
  return TOPUP_DEFAULTS.QUICK_AMOUNTS_SOM.filter((som) => amountProblem(som, limits) === null);
}
