import type { BankDirection, BankFeedSource } from '@repo/shared';
import { parseBankMessage } from '../../bank-feed/parsers/parse-bank-message';
import { InjectUsageError, balanceAfter, parseInjectArgs } from '../inject-args';
import { injectDatabaseRefusal, injectPrecheck } from '../../config/inject-guard';
import { syntheticBankText } from '../inject-text';

const AT = new Date('2030-05-01T10:07:00.000Z'); // 15:07 in Tashkent

describe('bank-feed-inject: synthetic text', () => {
  it.each<[BankFeedSource, BankDirection]>([
    ['HUMO_BOT', 'CREDIT'],
    ['HUMO_BOT', 'DEBIT'],
    ['UZCARD_BOT', 'CREDIT'],
    ['UZCARD_BOT', 'DEBIT'],
  ])('%s %s parses back to exactly the given values', (source, direction) => {
    const text = syntheticBankText({
      source,
      direction,
      amountTiyin: 5_001_750n,
      balanceAfterTiyin: 123_456_789n,
      last4: '4321',
      at: AT,
    });
    const parsed = parseBankMessage(source, text);
    expect(parsed).toMatchObject({
      ok: true,
      direction,
      amountTiyin: 5_001_750n,
      balanceAfterTiyin: 123_456_789n,
      last4: '4321',
      bankTxnAt: AT,
    });
  });
});

describe('bank-feed-inject: arguments', () => {
  it('parses so‘m into tiyin and the bank names into sources', () => {
    expect(
      parseInjectArgs(['--source', 'uzcard', '--amount', '50017.5', '--last4', '1111']),
    ).toEqual({
      source: 'UZCARD_BOT',
      direction: 'CREDIT',
      amountTiyin: 5_001_750n,
      last4: '1111',
      balanceTiyin: null,
    });
    expect(
      parseInjectArgs([
        '--source',
        'humo',
        '--amount',
        '10',
        '--last4',
        '0000',
        '--debit',
        '--balance',
        '5',
      ]),
    ).toMatchObject({ source: 'HUMO_BOT', direction: 'DEBIT', balanceTiyin: 500n });
  });

  it.each([
    [['--amount', '1', '--last4', '1111']],
    [['--source', 'visa', '--amount', '1', '--last4', '1111']],
    [['--source', 'humo', '--last4', '1111']],
    [['--source', 'humo', '--amount', '-5', '--last4', '1111']],
    [['--source', 'humo', '--amount', '1.234', '--last4', '1111']],
    [['--source', 'humo', '--amount', '1', '--last4', '11a1']],
    [['--source', 'humo', '--amount', '1', '--last4', '1111', '--card', '8600']],
  ])('refuses %j', (argv) => {
    expect(() => parseInjectArgs(argv)).toThrow(InjectUsageError);
  });

  it('the balance moves from the last one; a debit below zero needs --balance', () => {
    const credit = parseInjectArgs(['--source', 'humo', '--amount', '100', '--last4', '1111']);
    expect(balanceAfter(credit, null)).toBe(10_000n);
    expect(balanceAfter(credit, 50_000n)).toBe(60_000n);
    const debit = parseInjectArgs([
      '--source',
      'humo',
      '--amount',
      '100',
      '--last4',
      '1111',
      '--debit',
    ]);
    expect(balanceAfter(debit, 50_000n)).toBe(40_000n);
    expect(() => balanceAfter(debit, 5_000n)).toThrow(InjectUsageError);
  });
});

describe('inject guard (D-52 r2: after connecting, a _test database or the dev marker)', () => {
  const DEV = 'postgresql://u:p@localhost:5433/ggpin';

  it('before connecting: only a parseable URL and no live setting; the URL name is kept', () => {
    expect(injectPrecheck({ DATABASE_URL: DEV })).toEqual({ refusal: null, urlDatabase: 'ggpin' });
    expect(injectPrecheck({ DATABASE_URL: 'postgresql://u:p@db:5432/ggpin_test' })).toEqual({
      refusal: null,
      urlDatabase: 'ggpin_test',
    });
    expect(injectPrecheck({})).toEqual({ refusal: 'DATABASE_URL is not a valid URL' });
  });

  it('refuses when any live bank-feed setting is present, naming it but never its value', () => {
    for (const name of ['BANK_FEED_SESSION_ENC', 'BANK_FEED_API_HASH', 'BANK_FEED_ENC_KEY_FILE']) {
      const { refusal } = injectPrecheck({ DATABASE_URL: DEV, [name]: 'TESTVALUE_secret' });
      expect(refusal).toContain(name);
      expect(refusal).not.toContain('TESTVALUE');
    }
    expect(injectPrecheck({ DATABASE_URL: DEV, BANK_FEED_API_HASH: ' ' }).refusal).toBeNull();
  });

  it('refuses session options (L-1, r3): a URL options parameter or PGOPTIONS, values unechoed', () => {
    for (const query of ['?options=-c%20ggpin.env%3Ddev', '?sslmode=disable&Options=-c%20x%3Dy']) {
      const { refusal } = injectPrecheck({ DATABASE_URL: `${DEV}${query}` });
      expect(refusal).toMatch(/options parameter/);
      expect(refusal).not.toContain('ggpin.env');
    }
    const { refusal } = injectPrecheck({ DATABASE_URL: DEV, PGOPTIONS: '-c ggpin.env=dev' });
    expect(refusal).toMatch(/PGOPTIONS is set/);
    expect(refusal).not.toContain('ggpin.env');
    expect(injectPrecheck({ DATABASE_URL: DEV, PGOPTIONS: ' ' }).refusal).toBeNull();
    expect(injectPrecheck({ DATABASE_URL: `${DEV}?sslmode=disable` }).refusal).toBeNull();
  });

  it('after connecting: the marker, or the URL database itself ending with _test; a name is not enough', () => {
    expect(injectDatabaseRefusal({ name: 'ggpin', marker: 'dev' }, 'ggpin')).toBeNull();
    expect(injectDatabaseRefusal({ name: 'ggpin_test', marker: null }, 'ggpin_test')).toBeNull();
    // A tunnel to production looks like localhost/ggpin, or even localhost/ggpin_dev.
    expect(injectDatabaseRefusal({ name: 'ggpin', marker: null }, 'ggpin')).not.toBeNull();
    expect(injectDatabaseRefusal({ name: 'ggpin_dev', marker: null }, 'ggpin_dev')).not.toBeNull();
    expect(injectDatabaseRefusal({ name: 'ggpin', marker: null }, 'ggpin_test')).not.toBeNull();
  });
});
