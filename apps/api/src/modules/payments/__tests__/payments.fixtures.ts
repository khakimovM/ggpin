import { randomInt } from 'node:crypto';
import type { TopupCard } from '@repo/db';
import type { CardTotals } from '../card-pool.repository';

// Synthetic values only (never digits, names or amounts from real cards or screenshots).
// Receiving-card numbers start with 9999, a prefix no Uzbek issuer uses.

/** Appends the Luhn check digit to 15 digits. */
export function withLuhnDigit(fifteen: string): string {
  let sum = 0;
  for (let i = 0; i < fifteen.length; i += 1) {
    let digit = Number(fifteen[fifteen.length - 1 - i]);
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return `${fifteen}${String((10 - (sum % 10)) % 10)}`;
}

/** A random synthetic, Luhn-valid PAN: 9999 + 11 random digits + check digit. */
export function syntheticPan(): string {
  const middle = Array.from({ length: 11 }, () => String(randomInt(10))).join('');
  return withLuhnDigit(`9999${middle}`);
}

export const TEST_HOLDER = 'TESTOV SINOV';

export function cardRow(overrides: Partial<TopupCard> = {}): TopupCard {
  const pan = overrides.pan ?? withLuhnDigit('999900000000001');
  return {
    id: 'card_a',
    bank: 'HUMO',
    pan,
    last4: pan.slice(-4),
    holderName: TEST_HOLDER,
    status: 'ACTIVE',
    receiveLimitTiyin: 1_000_000_000n,
    monthlyLimitTiyin: null,
    verifyAmountTiyin: 100_100n,
    verifiedAt: new Date('2026-10-01T00:00:00.000Z'),
    retiredAt: null,
    autoCreditPaused: false,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

export function totals(
  card: Partial<TopupCard>,
  sums: Partial<Omit<CardTotals, 'card'>> = {},
): CardTotals {
  return {
    card: cardRow(card),
    receivedTiyin: 0n,
    receivedMonthTiyin: 0n,
    reservedTiyin: 0n,
    ...sums,
  };
}
