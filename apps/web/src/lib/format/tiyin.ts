import { formatMoney, type MoneyLocale } from '@repo/shared';

// Signed decimal integer, as money travels on the wire (ledger rows are negative for purchases).
// Checked before BigInt(): BigInt('') is 0n and BigInt('1.5') throws, and a display helper must
// do neither.
const TIYIN_STRING = /^-?(0|[1-9]\d{0,18})$/;

/**
 * "12 550" / "−1 200" from a tiyin string; null when the input is not a tiyin string. The
 * browser only lays out an amount the server sent: it never converts through `Number`.
 */
export function formatTiyinString(tiyin: string, locale: MoneyLocale): string | null {
  if (!TIYIN_STRING.test(tiyin)) return null;
  return formatMoney(BigInt(tiyin), locale);
}
