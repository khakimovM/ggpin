import path from 'node:path';
import { FAKE, OWNER_WALLET, cookieLine } from '../../adapters/fragment/__tests__/fragment-fakes';
import { RecordUsageError, parseFragmentRecordArgs } from '../fragment-record-args';
import { parseCookieFile, parseRedactFile, parseTonConnectFile } from '../fragment-record-inputs';
import { DEVICE } from './fake-fragment';

const CTX = {
  home: path.resolve('/home/owner'),
  cwd: path.resolve('/repo/apps/worker'),
  now: new Date('2030-01-02T03:04:05.678Z'),
};

const BASE = ['--cookies', 'c.txt', '--username', 'owner_1', '--telegram-id', '700100200'];
const CONFIRM_FLAGS = ['--confirm-no-payment', '--wallet', OWNER_WALLET, '--name', 'Ozodbek Sinov'];

describe('fragment-record: arguments', () => {
  it('fills the defaults: raw under ggpin-secrets, staging OUTSIDE it (R-3), never the cwd (n3)', () => {
    expect(
      parseFragmentRecordArgs(
        ['--cookies', 'c.txt', '--username', '@Owner_1', '--telegram-id', '700100200'],
        CTX,
      ),
    ).toEqual({
      cookiesFile: path.resolve(CTX.cwd, 'c.txt'),
      username: 'Owner_1',
      outDir: path.join(
        CTX.home,
        'Desktop',
        'ggpin-secrets',
        'fragment-raw',
        '2030-01-02T03-04-05-678Z',
      ),
      fixturesDir: path.join(
        CTX.home,
        'Desktop',
        'ggpin-fixtures-staging',
        '2030-01-02T03-04-05-678Z',
      ),
      confirmNoPayment: false,
      recipientAgeCheck: false,
      tonConnectFile: null,
      redactFile: null,
      telegramId: '700100200',
      wallet: null,
      names: [],
      phones: [],
    });
  });

  it('reads the flags and optional files (--name and --phone repeat)', () => {
    const args = parseFragmentRecordArgs(
      [
        ...BASE,
        ...CONFIRM_FLAGS,
        '--name',
        'Ggwork Co',
        '--phone',
        '+998 00 000 00 01',
        '--recipient-age-check',
        '--ton-connect',
        'tc.json',
        '--redact',
        'r.txt',
        '--out',
        '/tmp/raw',
      ],
      CTX,
    );
    expect(args).toMatchObject({
      confirmNoPayment: true,
      recipientAgeCheck: true,
      tonConnectFile: path.resolve(CTX.cwd, 'tc.json'),
      redactFile: path.resolve(CTX.cwd, 'r.txt'),
      telegramId: '700100200',
      wallet: OWNER_WALLET,
      names: ['Ozodbek Sinov', 'Ggwork Co'],
      phones: ['+998 00 000 00 01'],
      outDir: path.resolve(CTX.cwd, '/tmp/raw'),
    });
  });

  it.each([
    [[]],
    [['--username', 'owner_1', '--telegram-id', '700100200']],
    [['--cookies', 'c.txt', '--telegram-id', '700100200']],
    [[...BASE.slice(0, 2), '--username', 'a b', '--telegram-id', '700100200']],
    [[...BASE.slice(0, 2), '--username', '1owner', '--telegram-id', '700100200']],
    [[...BASE, '--recipient-age-check']],
    [['--cookies', 'c.txt', '--username', 'owner_1', '--telegram-id', '12ab']],
    [[...BASE, '--send']],
    [[...BASE, 'extra']],
    [[...BASE, '--wallet', 'not-a-wallet']],
    [[...BASE, '--name', 'ab']],
    [[...BASE, '--phone', '12345']],
  ])('refuses %j', (argv) => {
    expect(() => parseFragmentRecordArgs(argv, CTX)).toThrow(RecordUsageError);
  });

  it('N10: --telegram-id is required even without the purchase steps', () => {
    expect(() =>
      parseFragmentRecordArgs(['--cookies', 'c.txt', '--username', 'owner_1'], CTX),
    ).toThrow(/--telegram-id is required/);
  });

  it('R-4: --confirm-no-payment needs --wallet', () => {
    expect(() =>
      parseFragmentRecordArgs([...BASE, '--confirm-no-payment', '--name', 'Ozodbek Sinov'], CTX),
    ).toThrow(/--confirm-no-payment needs --wallet/);
  });

  it('R-2, M-1: --confirm-no-payment needs --name; a --redact file is not enough', () => {
    expect(() =>
      parseFragmentRecordArgs([...BASE, '--confirm-no-payment', '--wallet', OWNER_WALLET], CTX),
    ).toThrow(/--confirm-no-payment needs --name/);
    const withRedact = [
      ...BASE,
      '--confirm-no-payment',
      '--wallet',
      OWNER_WALLET,
      '--redact',
      'r.txt',
    ];
    expect(() => parseFragmentRecordArgs(withRedact, CTX)).toThrow(
      /--confirm-no-payment needs --name/,
    );
  });
});

describe('fragment-record: --phone (F-3)', () => {
  it('--confirm-no-payment needs --phone (or a --redact file)', () => {
    expect(() => parseFragmentRecordArgs([...BASE, ...CONFIRM_FLAGS], CTX)).toThrow(
      /--confirm-no-payment needs --phone/,
    );
    const withPhone = [...BASE, ...CONFIRM_FLAGS, '--phone', '+998 90 000 00 01'];
    expect(parseFragmentRecordArgs(withPhone, CTX).phones).toEqual(['+998 90 000 00 01']);
    const withRedact = [...BASE, ...CONFIRM_FLAGS, '--redact', 'r.txt'];
    expect(parseFragmentRecordArgs(withRedact, CTX).phones).toEqual([]);
  });
});

describe('fragment-record: input files', () => {
  it('reads a copied Cookie header line and name=value lines', () => {
    const fromHeader = parseCookieFile(`\uFEFFCookie: ${cookieLine()}\r\n`);
    expect([...fromHeader.keys()]).toEqual([
      'stel_ssid',
      'stel_dt',
      'stel_token',
      'stel_ton_token',
    ]);
    expect(fromHeader.get('stel_ssid')).toBe(FAKE.ssid);
    const fromLines = parseCookieFile(`# copied\nstel_ssid=${FAKE.ssid}\nstel_dt=-300\n`);
    expect(fromLines.get('stel_dt')).toBe('-300');
  });

  it('rejects a malformed cookies file without echoing its content', () => {
    for (const text of ['', `stel_ssid ${FAKE.ssid}`, `=${FAKE.ssid}`, 'a=b\u0007c']) {
      let message = '';
      try {
        parseCookieFile(text);
      } catch (error) {
        expect(error).toBeInstanceOf(RecordUsageError);
        message = error instanceof Error ? error.message : '';
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(FAKE.ssid);
    }
  });

  it('reads a TON Connect account (object or JSON string) and an optional device', () => {
    const account = { address: OWNER_WALLET, chain: '-239', publicKey: 'aa', extra: 'x' };
    const info = parseTonConnectFile(
      JSON.stringify({ account: JSON.stringify(account), device: DEVICE }),
    );
    expect(info).toEqual({
      address: OWNER_WALLET,
      publicKey: 'aa',
      walletStateInit: null,
      accountJson: JSON.stringify({ address: OWNER_WALLET, chain: '-239', publicKey: 'aa' }),
      deviceJson: JSON.stringify(DEVICE),
    });
    expect(() => parseTonConnectFile('{"account":{"address":"nope"}}')).toThrow(RecordUsageError);
    expect(() => parseTonConnectFile('{')).toThrow(RecordUsageError);
  });

  it.each(['sessionCrypto', 'secretKey'])('S-11: refuses a device with %s', (key) => {
    const account = { address: OWNER_WALLET };
    const device = { ...DEVICE, [key]: 'fake' };
    expect(() => parseTonConnectFile(JSON.stringify({ account, device }))).toThrow(
      /device may hold only DeviceInfo keys/,
    );
    expect(() =>
      parseTonConnectFile(JSON.stringify({ account, device: DEVICE, [key]: 'x' })),
    ).toThrow(RecordUsageError);
  });

  it('reads the redact list: texts, TON addresses and phone lines (R-9)', () => {
    const lines = [
      '# names',
      'Ggwork Account',
      '',
      '+998 00 ***',
      OWNER_WALLET,
      '8 (916) 000-00-01',
    ];
    expect(parseRedactFile(lines.join('\n'))).toEqual({
      texts: ['Ggwork Account', '+998 00 ***'],
      addresses: [OWNER_WALLET],
      phones: ['8 (916) 000-00-01'],
    });
    expect(() => parseRedactFile('ab\n')).toThrow(RecordUsageError);
  });
});
