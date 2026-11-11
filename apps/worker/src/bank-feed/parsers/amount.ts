import { somToTiyin } from '@repo/shared';

/**
 * Largest amount or balance a bank message may carry: 1 trillion so'm. Far above any card
 * balance, and far below the int8 column limit (9.2e18 tiyin): a parsed value must always fit
 * the `BankMessage` row, otherwise the listener's INSERT (in one transaction with the cursor)
 * fails on every poll and the message blocks the feed.
 */
export const MAX_BANK_AMOUNT_TIYIN = 100_000_000_000_000n;

// docs/05-PAYMENTS.md §5, rule 4: currency `UZS` required, exactly two decimals. Leading zeros are
// refused (a bank never prints "020 341.00"), so one value has one spelling. The digit count is
// bounded (at most 15 whole digits) so a huge digit run is refused by the pattern itself.
const AMOUNT_PATTERNS: readonly RegExp[] = [
  // Humo style: dot thousands, comma decimals ("20.341,00 UZS").
  /^(?:0|[1-9]\d{0,2}(?:\.\d{3}){0,4}),\d{2} UZS$/,
  // Uzcard style: space thousands, dot decimals ("20 341.00 UZS").
  /^(?:0|[1-9]\d{0,2}(?: \d{3}){0,4})\.\d{2} UZS$/,
  // No thousands separator ("20341.00 UZS" / "20341,00 UZS").
  /^(?:0|[1-9]\d{0,14})[.,]\d{2} UZS$/,
];

const NON_DIGIT = /\D/g;

/**
 * "20.341,00 UZS" / "20 341.00 UZS" / "20341.00 UZS" → 2034100n tiyin; any other shape, or a
 * value above `MAX_BANK_AMOUNT_TIYIN`, → null. The digits are rebuilt as a canonical "12345.67"
 * and converted by the shared `somToTiyin`: no float and no money math here.
 */
export function parseUzsAmount(text: string): bigint | null {
  if (!AMOUNT_PATTERNS.some((pattern) => pattern.test(text))) return null;
  // Every pattern ends in exactly two decimal digits followed by " UZS".
  const digits = text.replace(NON_DIGIT, '');
  const tiyin = somToTiyin(`${digits.slice(0, -2)}.${digits.slice(-2)}`);
  return tiyin > MAX_BANK_AMOUNT_TIYIN ? null : tiyin;
}
