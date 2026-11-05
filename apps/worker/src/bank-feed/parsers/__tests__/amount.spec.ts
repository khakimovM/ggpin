import { parseUzsAmount } from '../amount';

describe('parseUzsAmount', () => {
  it.each([
    ['Humo style', '20.341,00 UZS', 2_034_100n],
    ['Humo style balance', '123.456,78 UZS', 12_345_678n],
    ['Uzcard style', '20 341.00 UZS', 2_034_100n],
    ['Uzcard style balance', '987 654.32 UZS', 98_765_432n],
    ['no separator, dot', '20341.00 UZS', 2_034_100n],
    ['no separator, comma', '20341,00 UZS', 2_034_100n],
    ['zero (a balance may be zero)', '0,00 UZS', 0n],
    ['under one thousand', '341.00 UZS', 34_100n],
  ])('%s: %s', (_, text, tiyin) => {
    expect(parseUzsAmount(text)).toBe(tiyin);
  });

  it('a large amount is exact tiyin (float would round 99999999.99 * 100)', () => {
    expect(parseUzsAmount('99 999 999.99 UZS')).toBe(9_999_999_999n);
    expect(parseUzsAmount('99.999.999,99 UZS')).toBe(9_999_999_999n);
    expect(parseUzsAmount('99999999.99 UZS')).toBe(9_999_999_999n);
    expect(typeof parseUzsAmount('99 999 999.99 UZS')).toBe('bigint');
  });

  it.each([
    ['one decimal', '20 341.0 UZS'],
    ['three decimals', '20 341.000 UZS'],
    ['three decimals, Humo', '20.341,000 UZS'],
    ['no decimals', '20 341 UZS'],
    ['USD', '20 341.00 USD'],
    ['no currency', '20 341.00'],
    ['lower-case currency', '20 341.00 uzs'],
    ['currency glued', '20 341.00UZS'],
    ['currency first', 'UZS 20 341.00'],
    ['dot thousands with dot decimals', '20.341.00 UZS'],
    ['space thousands with comma decimals', '20 341,00 UZS'],
    ['short thousands group', '20 34.00 UZS'],
    ['long first group', '2034 100.00 UZS'],
    ['leading zero', '020 341.00 UZS'],
    ['leading zero, no separator', '020341.00 UZS'],
    ['negative', '-20 341.00 UZS'],
    ['explicit plus', '+20 341.00 UZS'],
    ['exponent', '2e4 UZS'],
    ['non-ASCII digits', '\u0662\u0660 341.00 UZS'],
    ['empty', ''],
  ])('rejects %s', (_, text) => {
    expect(parseUzsAmount(text)).toBeNull();
  });
});
