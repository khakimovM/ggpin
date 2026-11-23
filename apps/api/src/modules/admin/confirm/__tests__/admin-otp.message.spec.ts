import { AdminConfirmationBodySchema, type AdminConfirmationBody } from '@repo/shared';
import { randomUUID } from 'node:crypto';
import { adminConfirmText, type AdminConfirmSubject } from '../admin-otp.message';

// C-2 / SA-S6-2: the code message names the action, the signed amount, the account or card and
// every flag the code is bound to, in the admin's language; never a raw permission key.
const body = (raw: object): AdminConfirmationBody => AdminConfirmationBodySchema.parse(raw);
// The key is bound but not shown in the message: a random one keeps the snapshots stable.
const key = () => randomUUID();
const ID = 'cmuser000000000000000001';
const user = { username: 'ali_test', telegramId: 1234567890n };

/** The binding's own words; the message shows each in the admin's language instead. */
const RAW_FLAG_WORDS = [
  'override',
  'bank-verified',
  'otpRequired',
  'daily-limit',
  'confirmOverride',
  'confirmSecurityPause',
  'emergency',
  'monthlyLimit',
  'blocked, ',
  'overLimit',
  'recent auto',
] as const;

const cases: readonly [string, AdminConfirmationBody, readonly string[], AdminConfirmSubject][] = [
  [
    'adjust credit with override',
    body({
      action: 'users.adjustWallet',
      targetId: ID,
      amountTiyin: '12345600',
      confirmOverrideSet: 'abcdef012345',
      idempotencyKey: key(),
    }),
    ['override: 2 recent auto top-up(s), set abcdef012345'],
    { amount: { tiyin: 12_345_600n, signed: true }, user },
  ],
  [
    'codeless-budget debit of a user without a username',
    body({
      action: 'users.adjustWallet',
      targetId: ID,
      amountTiyin: '-50000',
      idempotencyKey: key(),
    }),
    ['otpRequired: daily-limit'],
    { amount: { tiyin: -50_000n, signed: true }, user: { username: null, telegramId: 987654321n } },
  ],
  [
    'reverse',
    body({ action: 'payments.reverse', targetId: ID, amountTiyin: '30000000' }),
    [],
    { amount: { tiyin: -30_000_000n, signed: true }, user },
  ],
  [
    'review credit, bank-verified',
    body({
      action: 'payments.reviewCredit',
      targetId: ID,
      amountTiyin: '500000000',
      userId: ID,
      bankVerified: true,
    }),
    ['bank-verified'],
    { amount: { tiyin: 500_000_000n, signed: true }, user },
  ],
  [
    'security resume',
    body({ action: 'cards.resume', targetId: ID, confirmSecurityPause: true }),
    [],
    { card: { bank: 'HUMO', last4: '4321' } },
  ],
  [
    'emergency retire',
    body({ action: 'cards.retire', targetId: ID, emergency: true }),
    [],
    { card: { bank: 'UZCARD', last4: '9876' } },
  ],
  [
    'review credit over a blocked, over-limit user (one joined server flag)',
    body({
      action: 'payments.reviewCredit',
      targetId: ID,
      amountTiyin: '500000000',
      userId: ID,
      confirmOverride: true,
      bankVerified: true,
    }),
    ['override: blocked, overLimit; bank-verified'],
    { amount: { tiyin: 500_000_000n, signed: true }, user },
  ],
  [
    'adjust credit, override asked with nothing to override',
    body({
      action: 'users.adjustWallet',
      targetId: ID,
      amountTiyin: '20000000',
      confirmOverrideSet: 'abcdef012345',
      idempotencyKey: key(),
    }),
    ['override: none'],
    { amount: { tiyin: 20_000_000n, signed: true }, user },
  ],
  [
    'resume over a card warning',
    body({ action: 'cards.resume', targetId: ID, confirmOverride: true }),
    [],
    { card: { bank: 'UZCARD', last4: '9876' } },
  ],
  [
    'raised limit with a monthly cap',
    body({
      action: 'cards.limit',
      targetId: ID,
      receiveLimitTiyin: '2000000000',
      monthlyLimitTiyin: '30000000000',
    }),
    [],
    { amount: { tiyin: 2_000_000_000n, signed: false }, card: { bank: 'HUMO', last4: '4321' } },
  ],
  [
    'lowered limit with the monthly cap removed',
    body({
      action: 'cards.limit',
      targetId: ID,
      receiveLimitTiyin: '1000000000',
      monthlyLimitTiyin: null,
    }),
    [],
    { amount: { tiyin: 1_000_000_000n, signed: false }, card: { bank: 'HUMO', last4: '4321' } },
  ],
  // Phase 9 S9a: the admin-management codes name the admin (masked id) and the body in words.
  [
    'add an admin (no row yet: the masked id it asks for)',
    body({ action: 'admins.create', telegramId: '5550001234', name: 'Shift two', role: 'SUPPORT' }),
    [],
    { admin: { name: null, telegramId: 5_550_001_234n } },
  ],
  [
    'rename and move an admin to SUPPORT',
    body({ action: 'admins.update', targetId: ID, name: 'Night shift', role: 'SUPPORT' }),
    [],
    { admin: { name: 'Operator', telegramId: 5_550_001_234n } },
  ],
  [
    'deactivate an admin',
    body({ action: 'admins.update', targetId: ID, isActive: false }),
    [],
    { admin: { name: 'Operator', telegramId: 5_550_001_234n } },
  ],
  [
    'reactivate an admin',
    body({ action: 'admins.update', targetId: ID, isActive: true }),
    [],
    { admin: { name: 'Operator', telegramId: 5_550_001_234n } },
  ],
  [
    'end every session of an admin',
    body({ action: 'admins.sessionsRevoke', targetId: ID }),
    [],
    { admin: { name: 'Owner', telegramId: 5_550_001_234n } },
  ],
  [
    'end one session',
    body({ action: 'sessions.revoke', targetId: ID }),
    [],
    { admin: { name: 'Owner', telegramId: 5_550_001_234n } },
  ],
];

describe.each(['uz', 'ru'] as const)('admin confirmation code message (%s)', (locale) => {
  it.each(cases)('%s', (_name, confirmation, serverFlags, subject) => {
    const text = adminConfirmText(locale, {
      code: '123456',
      body: confirmation,
      serverFlags,
      subject,
    });
    expect(text).toMatchSnapshot();
    // The panel's test helper reads the code right after the first colon.
    expect(text).toMatch(/: 123456\n/);
    expect(text).not.toContain(confirmation.action);
    // Every flag is in words: no binding key reaches the chat, only the set id it names.
    for (const raw of RAW_FLAG_WORDS) expect(text).not.toContain(raw);
    for (const flag of serverFlags) {
      for (const set of flag.match(/[0-9a-f]{12}/g) ?? []) expect(text).toContain(set);
    }
  });

  it('shows a flag it does not know as it is, never hiding it', () => {
    const text = adminConfirmText(locale, {
      code: '123456',
      body: body({ action: 'payments.reverse', targetId: ID, amountTiyin: '1' }),
      serverFlags: ['future: flag; bank-verified'],
      subject: { user },
    });
    expect(text).toContain('future: flag; ');
    expect(text).not.toContain('bank-verified');
  });

  it('escapes a flag it does not know: no markup reaches the HTML message', () => {
    const text = adminConfirmText(locale, {
      code: '123456',
      body: body({ action: 'payments.reverse', targetId: ID, amountTiyin: '1' }),
      serverFlags: ['future: <b>x</b>'],
      subject: { user },
    });
    expect(text).toContain('future: &lt;b&gt;x&lt;/b&gt;');
    expect(text).not.toContain('<b>');
  });

  it('names the amount of a card limit change the new limit', () => {
    const limit = cases.find(([, c]) => c.action === 'cards.limit');
    const reverse = cases.find(([, c]) => c.action === 'payments.reverse');
    if (limit === undefined || reverse === undefined) throw new Error('cases changed');
    const [newLimit, sum] =
      locale === 'uz' ? ['Yangi limit:', 'Summa:'] : ['Новый лимит:', 'Сумма:'];
    const text = (c: (typeof cases)[number]) =>
      adminConfirmText(locale, { code: '123456', body: c[1], serverFlags: c[2], subject: c[3] });
    expect(text(limit)).toContain(`
${newLimit} `);
    expect(text(limit)).not.toContain(sum);
    expect(text(reverse)).toContain(`
${sum} `);
  });

  it('escapes an admin name exactly once, in the target and in the new-name flag', () => {
    const text = adminConfirmText(locale, {
      code: '123456',
      body: body({ action: 'admins.update', targetId: ID, name: 'Tom & Jerry' }),
      serverFlags: [],
      subject: { admin: { name: 'Ali & Vali', telegramId: 5_550_001_234n } },
    });
    expect(text).toContain('Ali &amp; Vali · 55******34');
    expect(text).toContain('Tom &amp; Jerry');
    expect(text).not.toContain('&amp;amp;');
    expect(text).not.toContain('5550001234');
  });

  it('masks the Telegram id: the full id never reaches the chat', () => {
    const text = adminConfirmText(locale, {
      code: '123456',
      body: body({ action: 'payments.reverse', targetId: ID, amountTiyin: '1' }),
      serverFlags: [],
      subject: { user: { username: null, telegramId: 987654321n } },
    });
    expect(text).toContain('98*****21');
    expect(text).not.toContain('987654321');
  });
});

describe('Uzbek apostrophes', () => {
  it('uses ‘ (U+2018) after o/g and ʼ (U+02BC) for the tutuq, never an ASCII quote', () => {
    for (const [, confirmation, serverFlags, subject] of cases) {
      const text = adminConfirmText('uz', {
        code: '123456',
        body: confirmation,
        serverFlags,
        subject,
      });
      expect(text).not.toMatch(/[oOgG]['’`]/);
    }
  });
});
