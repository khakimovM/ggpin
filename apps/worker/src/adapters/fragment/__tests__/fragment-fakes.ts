import type { SecretValue } from '../secret-forms';
import { tonAddressForms } from '../ton-address-forms';

// Made-up Fragment-like data for the sanitizer, leak-check and recorder tests. Every value is
// fake and built at runtime (gitleaks: no cookie-looking literal in source). The response SHAPES
// are the guesses of docs/suppliers/fragment.md, not recordings.

export const BS = String.fromCharCode(92);
const EMOJI = String.fromCodePoint(0x1f3ae);
const NUL4 = String.fromCharCode(0, 0, 0, 0);

const PAY_FILL = 0x2a;

type Form = 'raw' | 'bounceable' | 'non-bounceable' | 'std';

/** One text form of a made-up account (url-safe base64 unless `std`). */
export const form = (fill: number, kind: Form, workchain = 0): string => {
  const forms = tonAddressForms({ workchain, hash: Buffer.alloc(32, fill) });
  const found =
    kind === 'raw'
      ? forms.find((f) => f.includes(':'))
      : kind === 'std'
        ? forms.find((f) => f.startsWith('UQ') && f.includes('/'))
        : forms.find((f) => f.startsWith(kind === 'bounceable' ? 'E' : 'U') && !/[+/:]/.test(f));
  if (found === undefined) throw new Error('no such address form');
  return found;
};

/** A fill (not the pay address one) whose non-bounceable std-base64 form has a `/` (audit F). */
export function slashAccountFill(): number {
  for (let fill = 1; fill < 256; fill += 1) {
    if (fill === PAY_FILL) continue;
    const forms = tonAddressForms({ workchain: 0, hash: Buffer.alloc(32, fill) });
    if (forms.some((f) => f.startsWith('UQ') && f.includes('/'))) return fill;
  }
  throw new Error('no fill with a slash form');
}

export const FRAGMENT_PAY_ADDRESS = form(PAY_FILL, 'bounceable');
export const OWNER_WALLET = form(0x07, 'bounceable');
export const OWNER_WALLET_RAW = form(0x07, 'raw');
export const OWNER_WALLET_NON_BOUNCEABLE = form(0x07, 'non-bounceable');
export const STRANGER_WALLET = form(0x55, 'bounceable');

export const FAKE = {
  ssid: `fake${'ssid'}0000aaaa1111bbbb`,
  token: `fake${'token'}2222cccc3333dddd`,
  tonToken: `fake${'tontoken'}4444eeee5555`,
  refreshedSsid: `fake${'refreshed'}6666ffff7777`,
  dt: '-300',
  hash: ['ab12', 'cd34', 'ef56', '7890', 'aa'].join(''),
  username: 'owner_test_acc',
  /** Latin + Cyrillic + an emoji outside the BMP (M1, m3). */
  displayName: `Ozodbek Синов ${EMOJI}`,
  /** Shown as `Ggwork &amp; Co` in a page (m3). */
  accountName: 'Ggwork & Co',
  recipient: `fakeRecipient${'Opaque'}0123456789`,
  telegramId: '700100200',
  phone: '+998000000001',
  photoUrl: 'https://cdn4.telesco.pe/file/fakeUserpicFile0000.jpg',
  reqId: 'fakeReq0001',
};

/** Code-unit JSON escapes for non-ASCII (`С`, `🎮`), as PHP json_encode writes. */
export function jsonEscaped(text: string): string {
  return [...text]
    .map((ch) =>
      ch.charCodeAt(0) < 0x80
        ? ch
        : [...Array(ch.length).keys()]
            .map((i) => `${BS}u${ch.charCodeAt(i).toString(16).padStart(4, '0')}`)
            .join(''),
    )
    .join('');
}

/** Hex HTML entities for non-ASCII (`&#x421;`, `&#x1F3AE;`), `&amp;` for `&`. */
export function htmlHexEntities(text: string): string {
  return [...text]
    .map((ch) => {
      if (ch === '&') return '&amp;';
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x80 ? ch : `&#x${code.toString(16).toUpperCase()};`;
    })
    .join('');
}

export function cookieLine(): string {
  return [
    `stel_ssid=${FAKE.ssid}`,
    `stel_dt=${FAKE.dt}`,
    `stel_token=${FAKE.token}`,
    `stel_ton_token=${FAKE.tonToken}`,
  ].join('; ');
}

export function loggedInPage(): string {
  return [
    '<!DOCTYPE html><html><head><title>Fragment</title></head><body>',
    `<div class="tm-menu-tg-account"><img src="${FAKE.photoUrl}">`,
    `<div class="tm-menu-tg-account-name">${htmlHexEntities(FAKE.accountName)}</div></div>`,
    `<div class="tm-wallet">${OWNER_WALLET_NON_BOUNCEABLE}</div>`,
    `<a href="https://tonviewer.com/${OWNER_WALLET_NON_BOUNCEABLE}">wallet</a>`,
    `<a class="js-logout" href="#">Log out</a>`,
    `<span class="tm-display">${htmlHexEntities(FAKE.displayName)}</span>`,
    `<script>ajInit({"version":1,"apiUrl":"${BS}/api?hash=${FAKE.hash}",`,
    `"state":{"uid":${FAKE.telegramId},"username":"${FAKE.username}","phone":"${FAKE.phone}",`,
    `"title":"${jsonEscaped(FAKE.displayName)}"},`,
    `"cookie":"stel_dt=${FAKE.dt}","stel_token":"${FAKE.token}"});</script>`,
    '</body></html>',
  ].join('\n');
}

export function loggedOutPage(): string {
  return [
    '<!DOCTYPE html><html><head><title>Fragment</title></head><body>',
    '<button class="btn js-header-login">Log in</button>',
    `<script>ajInit({"version":1,"apiUrl":"${BS}/api?hash=0000111122223333aa"});</script>`,
    '</body></html>',
  ].join('\n');
}

export function searchResponse(): Record<string, unknown> {
  return {
    ok: true,
    found: {
      myself: true,
      recipient: FAKE.recipient,
      name: FAKE.displayName,
      photo: `<img src="${FAKE.photoUrl}" width="160" height="160" alt="${FAKE.displayName}">`,
    },
  };
}

export function initResponse(): Record<string, unknown> {
  return {
    req_id: FAKE.reqId,
    myself: true,
    to_bot: false,
    amount: '0.2512',
    item_title: '50 Stars',
  };
}

const BOC_HEAD = Buffer.from([0xb5, 0xee, 0x9c, 0x72, 0x41, 0x01]);

/** A BOC-like payload with a text comment naming the recipient (what Fragment is guessed to send). */
export function payloadWithUsername(): string {
  const comment = Buffer.from(
    `${NUL4}50 Telegram Stars for @${FAKE.username}\n\nRef#${FAKE.reqId}`,
  );
  return Buffer.concat([BOC_HEAD, comment]).toString('base64');
}

/** Short base64 that is not a BOC and carries no secret: kept by the sanitizer. */
export function plainBase64(): string {
  return Buffer.from('50 Stars, no secret').toString('base64');
}

export function linkResponse(payload: string = payloadWithUsername()): Record<string, unknown> {
  return {
    ok: true,
    transaction: {
      validUntil: 1_900_000_000,
      from: OWNER_WALLET_RAW,
      messages: [{ address: FRAGMENT_PAY_ADDRESS, amount: '251200000', payload }],
    },
    confirm_method: 'confirmReq',
    confirm_params: { id: FAKE.reqId },
  };
}

/** Every secret above (and its parts) in the forms a leak could take. */
export function allSecretForms(): string[] {
  return [
    FAKE.ssid,
    FAKE.token,
    FAKE.tonToken,
    FAKE.refreshedSsid,
    FAKE.hash,
    FAKE.username,
    'Ozodbek',
    'Синов',
    'Ggwork',
    jsonEscaped('Синов'),
    htmlHexEntities('Синов'),
    FAKE.recipient,
    FAKE.telegramId,
    FAKE.phone,
    FAKE.phone.slice(1),
    'telesco.pe',
    'fakeUserpicFile0000',
    ...tonAddressForms({ workchain: 0, hash: Buffer.alloc(32, 0x07) }),
    ...tonAddressForms({ workchain: 0, hash: Buffer.alloc(32, 0x55) }),
  ];
}

/** The secrets a recording run would know for the data above. */
export const FAKE_SECRETS: SecretValue[] = [
  { kind: 'cookie', value: FAKE.ssid },
  { kind: 'cookie', value: FAKE.token },
  { kind: 'cookie', value: FAKE.tonToken },
  { kind: 'cookie', value: FAKE.dt },
  { kind: 'hash', value: FAKE.hash },
  { kind: 'username', value: FAKE.username },
  { kind: 'name', value: FAKE.displayName },
  { kind: 'name', value: FAKE.accountName },
  { kind: 'recipient', value: FAKE.recipient },
  { kind: 'address', value: OWNER_WALLET },
  { kind: 'tg_id', value: FAKE.telegramId },
];
