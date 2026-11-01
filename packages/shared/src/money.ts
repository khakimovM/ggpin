// The ONLY place for money math (.claude/rules/40-domain-money.md).
// Every amount is a BigInt in minor units; `number` is never used for an amount. Decimal
// strings exist only at the edges (user input, JSON, FX rates).

export type Currency = 'UZS' | 'USDT' | 'TON' | 'STARS';
export type Rounding = 'up' | 'down';
export type MoneyLocale = 'uz' | 'ru';

/** Decimal places of the minor unit: UZS tiyin 2, USDT micro 6, TON nano 9, Stars whole. */
export const CURRENCY_DECIMALS = {
  UZS: 2,
  USDT: 6,
  TON: 9,
  STARS: 0,
} as const satisfies Record<Currency, number>;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

const BPS_DENOMINATOR = 10_000n;
const TIYIN_PER_SOM = 100n;
// FX rates arrive from admin/sync as decimal strings; 18 places is far beyond any real quote
// and bounds the size of the BigInt products below.
const MAX_RATE_DECIMALS = 18;

// One regex for both parsers; the unsigned entry point rejects a leading minus afterwards so the
// error says why (a bare "invalid amount" would hide that the sign was the problem).
const MAJOR_RE = /^(-)?(\d+)(?:\.(\d+))?$/;
const RATE_RE = /^(\d+)(?:\.(\d+))?$/;

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function assertBigInt(value: unknown, name: string): asserts value is bigint {
  // Runtime guard: a JS caller (or a bad cast) passing a float must never reach the math.
  if (typeof value !== 'bigint') throw new MoneyError(`${name} must be a bigint`);
}

/**
 * Integer division with explicit direction. `up` is the mathematical ceiling (towards +inf),
 * `down` the floor (towards -inf) — NOT truncation, so negative numerators stay consistent.
 * Rule: round UP for cost, DOWN for amounts credited to users.
 */
function divide(numerator: bigint, denominator: bigint, rounding: Rounding): bigint {
  const quotient = numerator / denominator; // truncates towards zero
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  if (rounding === 'up') return numerator > 0n ? quotient + 1n : quotient;
  return numerator < 0n ? quotient - 1n : quotient;
}

function parseDecimalMajor(currency: Currency, input: string, allowNegative: boolean): bigint {
  if (typeof input !== 'string') throw new MoneyError('amount must be a decimal string');
  const match = MAJOR_RE.exec(input);
  if (!match) throw new MoneyError(`invalid ${currency} amount "${input}"`);
  const [, minus, whole = '', fraction = ''] = match;
  // "-0" is rejected too: a negative-zero string is never a legitimate user/admin amount.
  if (minus && !allowNegative) throw new MoneyError('amount must not be negative');
  const decimals = CURRENCY_DECIMALS[currency];
  if (fraction.length > decimals) {
    throw new MoneyError(`${currency} allows at most ${decimals} decimal places`);
  }
  const minor = BigInt(whole + fraction.padEnd(decimals, '0'));
  return minus ? -minor : minor;
}

/**
 * Parses a NON-NEGATIVE decimal string in MAJOR units ("12550.5") into minor units. This is
 * the parser for user- and admin-entered amounts (top-up, prices, limits): a leading minus,
 * including "-0", is rejected. Also rejects non-strings (floats), exponents, whitespace,
 * missing digits and more decimals than the unit allows — silently truncating user money is
 * never acceptable. Whether zero is acceptable is the caller's rule.
 */
export function parseMajor(currency: Currency, input: string): bigint {
  return parseDecimalMajor(currency, input, false);
}

/**
 * Explicit SIGNED path, only for deltas that are signed by nature (admin ADJUSTMENT, ledger
 * reversals). Never use it for a user-entered amount. "-0" normalises to 0n.
 */
export function parseSignedMajor(currency: Currency, input: string): bigint {
  return parseDecimalMajor(currency, input, true);
}

/** Minor units → canonical major decimal string; trailing zeros are trimmed ("125.5", "125"). */
export function formatMajor(currency: Currency, minor: bigint): string {
  assertBigInt(minor, 'amount');
  const decimals = CURRENCY_DECIMALS[currency];
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** "12550.5" so'm → 1255050 tiyin. Non-negative only (see parseMajor). */
export function somToTiyin(som: string): bigint {
  return parseMajor('UZS', som);
}

/** 1255050 tiyin → "12550.5". */
export function tiyinToSom(tiyin: bigint): string {
  return formatMajor('UZS', tiyin);
}

/** Rounds a tiyin amount UP to a whole so'm (customer prices have no tiyin). */
export function roundUpToSom(tiyin: bigint): bigint {
  assertBigInt(tiyin, 'amount');
  return divide(tiyin, TIYIN_PER_SOM, 'up') * TIYIN_PER_SOM;
}

interface ParsedRate {
  /** rate × 10^scaleDigits, always > 0 */
  readonly numerator: bigint;
  readonly scaleDigits: number;
}

function parseRate(rate: string): ParsedRate {
  if (typeof rate !== 'string') throw new MoneyError('rate must be a decimal string');
  const match = RATE_RE.exec(rate);
  if (!match) throw new MoneyError(`invalid FX rate "${rate}"`);
  const [, whole = '', fraction = ''] = match;
  if (fraction.length > MAX_RATE_DECIMALS) {
    throw new MoneyError(`FX rate allows at most ${MAX_RATE_DECIMALS} decimal places`);
  }
  const numerator = BigInt(whole + fraction);
  if (numerator === 0n) throw new MoneyError('FX rate must be positive');
  return { numerator, scaleDigits: fraction.length };
}

export interface ConvertInput {
  /** Amount in the SOURCE currency's minor units. */
  readonly amount: bigint;
  readonly from: Currency;
  readonly to: Currency;
  /** Decimal string: MAJOR target units per 1 MAJOR source unit (FxRate.rate). */
  readonly rate: string;
  /** `up` for costs, `down` for amounts credited to users. */
  readonly rounding: Rounding;
}

/**
 * Exact rational FX conversion between minor units; the only rounding is the final one.
 * The rate is major-per-major, so the minor/minor ratio is rate × 10^(toDec − fromDec).
 */
export function convert({ amount, from, to, rate, rounding }: ConvertInput): bigint {
  assertBigInt(amount, 'amount');
  const { numerator, scaleDigits } = parseRate(rate);
  return divide(
    amount * numerator * pow10(CURRENCY_DECIMALS[to]),
    pow10(CURRENCY_DECIMALS[from] + scaleDigits),
    rounding,
  );
}

/**
 * Inverse of `convert`: the rate is quoted FROM-per-TO (e.g. 12 600 so'm per 1 USDT) and the
 * amount in the `from` currency is DIVIDED by it. Needed because 1/rate is not an exact
 * decimal, so inverting the string first would lose precision before the only allowed rounding.
 */
export function convertInverse({ amount, from, to, rate, rounding }: ConvertInput): bigint {
  assertBigInt(amount, 'amount');
  const { numerator, scaleDigits } = parseRate(rate);
  return divide(
    amount * pow10(CURRENCY_DECIMALS[to] + scaleDigits),
    pow10(CURRENCY_DECIMALS[from]) * numerator,
    rounding,
  );
}

/**
 * The FxRate.pair values we store. The rate is QUOTE major units per 1 BASE major unit
 * (USDT_UZS = so'm per USDT), so base → quote multiplies and quote → base divides.
 */
export const FX_PAIRS = {
  USDT_UZS: { base: 'USDT', quote: 'UZS' },
  TON_USDT: { base: 'TON', quote: 'USDT' },
  TON_UZS: { base: 'TON', quote: 'UZS' },
} as const satisfies Record<string, { base: Currency; quote: Currency }>;
export type FxPair = keyof typeof FX_PAIRS;

export interface ConvertPairInput {
  readonly amount: bigint;
  readonly pair: FxPair;
  /** Which side of the pair `amount` is denominated in; the result is in the other side. */
  readonly from: Currency;
  /** FxRate.rate for `pair`. */
  readonly rate: string;
  readonly rounding: Rounding;
}

/** Converts across a stored FX pair in either direction (multiply or divide by the rate). */
export function convertPair({ amount, pair, from, rate, rounding }: ConvertPairInput): bigint {
  const { base, quote } = FX_PAIRS[pair];
  if (from === base) return convert({ amount, from: base, to: quote, rate, rounding });
  if (from === quote) return convertInverse({ amount, from: quote, to: base, rate, rounding });
  throw new MoneyError(`${from} is not a side of ${pair}`);
}

type PairConversion = Omit<ConvertPairInput, 'rounding'>;

/** What WE pay or must cover (supplier cost, hot-wallet need): rounds UP, never short. */
export function convertPairForCost(input: PairConversion): bigint {
  return convertPair({ ...input, rounding: 'up' });
}

/** What a USER is credited or refunded: rounds DOWN, never gives away a fraction. */
export function convertPairForCredit(input: PairConversion): bigint {
  return convertPair({ ...input, rounding: 'down' });
}

function assertBps(bps: number): bigint {
  // bps are small integers by nature (1% = 100); anything else is a caller bug.
  if (!Number.isSafeInteger(bps) || bps < 0) {
    throw new MoneyError('bps must be a non-negative integer');
  }
  return BigInt(bps);
}

/** cost × (1 + bps/10000). Pass 'up' when pricing so rounding never shaves the margin. */
export function applyMarkup(cost: bigint, bps: number, rounding: Rounding): bigint {
  assertBigInt(cost, 'amount');
  return divide(cost * (BPS_DENOMINATOR + assertBps(bps)), BPS_DENOMINATOR, rounding);
}

/** amount × bps/10000 (referral 1% = 100 bps, cashback, tolerance). */
export function percentOf(amount: bigint, bps: number, rounding: Rounding): bigint {
  assertBigInt(amount, 'amount');
  return divide(amount * assertBps(bps), BPS_DENOMINATOR, rounding);
}

// Locale rules come from the design handoff, not from Intl: ICU data differs between Node
// builds and would change grouping characters under our feet. uz and ru render identically.
const NARROW_NBSP = ' ';
const MINUS = '−';
const NUMBER_FORMAT = {
  uz: { group: NARROW_NBSP, decimal: ',', minus: MINUS },
  ru: { group: NARROW_NBSP, decimal: ',', minus: MINUS },
} as const satisfies Record<MoneyLocale, { group: string; decimal: string; minus: string }>;

/**
 * Formats a so'm amount as a bare number: "85 400", "85 400,50", "−1 200". The unit text
 * ("so‘m" / "сум") comes from i18n (`common.money.uzs`), never from here.
 */
export function formatMoney(amountTiyin: bigint, locale: MoneyLocale): string {
  assertBigInt(amountTiyin, 'amount');
  const { group, decimal, minus } = NUMBER_FORMAT[locale];
  const negative = amountTiyin < 0n;
  const absolute = negative ? -amountTiyin : amountTiyin;
  const som = (absolute / TIYIN_PER_SOM).toString().replace(/\B(?=(\d{3})+$)/g, group);
  const tiyin = absolute % TIYIN_PER_SOM;
  const fraction = tiyin === 0n ? '' : `${decimal}${tiyin.toString().padStart(2, '0')}`;
  return `${negative ? minus : ''}${som}${fraction}`;
}
