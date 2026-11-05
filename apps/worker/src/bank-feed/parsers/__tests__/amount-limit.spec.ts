import { somToTiyin } from '@repo/shared';
import { MAX_BANK_AMOUNT_TIYIN, parseUzsAmount } from '../amount';
import { parseBankMessage } from '../parse-bank-message';
import { humoMessage, uzcardMessage } from './synthetic';

// int8 (Postgres BIGINT) upper bound: a parsed value must always fit the BankMessage row.
const INT8_MAX = 9_223_372_036_854_775_807n;

// Review finding S5 #1: an unbounded amount would make the listener's INSERT fail forever.
// Boundary values below are artificial (1 trillion so'm), not taken from any real message.
describe('amount and balance upper bound', () => {
  it('is 1 trillion so\u{2018}m, far below int8', () => {
    expect(MAX_BANK_AMOUNT_TIYIN).toBe(100_000_000_000_000n);
    expect(MAX_BANK_AMOUNT_TIYIN < INT8_MAX).toBe(true);
  });

  it.each([
    ['Humo style', '1.000.000.000.000,00 UZS'],
    ['Uzcard style', '1 000 000 000 000.00 UZS'],
    ['no separator', '1000000000000.00 UZS'],
  ])('exactly the limit is accepted: %s', (_, text) => {
    expect(parseUzsAmount(text)).toBe(MAX_BANK_AMOUNT_TIYIN);
  });

  it.each([
    ['limit + 1 tiyin, Humo', '1.000.000.000.000,01 UZS'],
    ['limit + 1 tiyin, Uzcard', '1 000 000 000 000.01 UZS'],
    ['limit + 1 tiyin, no separator', '1000000000000.01 UZS'],
    ['15 whole digits (pattern allows, limit refuses)', '999 999 999 999 999.99 UZS'],
    ['16 whole digits, no separator', `${'9'.repeat(16)}.00 UZS`],
    ['six thousands groups, Humo', `9${'.999'.repeat(5)},00 UZS`],
    ['six thousands groups, Uzcard', `9${' 999'.repeat(5)}.00 UZS`],
    ['30 digits', `${'9'.repeat(28)},00 UZS`],
    ['3000 digits', `${'9'.repeat(2998)}.00 UZS`],
    ['30 digits in groups', `999${'.999'.repeat(9)},00 UZS`],
  ])('above the limit → null: %s', (_, text) => {
    expect(parseUzsAmount(text)).toBeNull();
  });

  it('an oversized amount line is AMOUNT_FORMAT', () => {
    const text = humoMessage({ direction: `\u{2795} ${'9'.repeat(28)},00 UZS` });
    expect(parseBankMessage('HUMO_BOT', text)).toEqual({ ok: false, reason: 'AMOUNT_FORMAT' });
    const atLimit = uzcardMessage({ direction: '\u{2795} 1 000 000 000 000.00 UZS' });
    expect(parseBankMessage('UZCARD_BOT', atLimit)).toEqual(
      expect.objectContaining({ ok: true, amountTiyin: MAX_BANK_AMOUNT_TIYIN }),
    );
  });

  it('an oversized balance line is BALANCE_FORMAT', () => {
    const text = humoMessage({ balance: '\u{1F4B0} 1.000.000.000.000,01 UZS' });
    expect(parseBankMessage('HUMO_BOT', text)).toEqual({ ok: false, reason: 'BALANCE_FORMAT' });
    const atLimit = humoMessage({ balance: '\u{1F4B0} 1.000.000.000.000,00 UZS' });
    expect(parseBankMessage('HUMO_BOT', atLimit)).toEqual(
      expect.objectContaining({ ok: true, balanceAfterTiyin: MAX_BANK_AMOUNT_TIYIN }),
    );
  });

  it('every accepted value fits int8', () => {
    const accepted = [
      '1.000.000.000.000,00 UZS',
      '999 999 999 999.99 UZS',
      '999999999999.99 UZS',
      '20 341.00 UZS',
    ];
    for (const text of accepted) {
      const tiyin = parseUzsAmount(text);
      expect(tiyin).not.toBeNull();
      expect(tiyin !== null && tiyin <= INT8_MAX).toBe(true);
    }
  });

  it('even the longest digit run the patterns allow would fit int8 without the limit', () => {
    // 15 whole digits + 2 decimals is the most any pattern accepts; the limit then refuses it,
    // but the column would hold it anyway (defence in depth).
    const longest = somToTiyin(`${'9'.repeat(15)}.99`);
    expect(longest).toBe(99_999_999_999_999_999n);
    expect(longest <= INT8_MAX).toBe(true);
    for (const text of [
      '999.999.999.999.999,99 UZS',
      '999 999 999 999 999.99 UZS',
      `${'9'.repeat(15)}.99 UZS`,
    ]) {
      expect(parseUzsAmount(text)).toBeNull();
    }
  });
});
