import { z } from 'zod';
import { parseTonAddress } from '../adapters/fragment/ton-address-forms';
import { RecordUsageError } from './fragment-record-args';

// Input files of `fragment:record`: the copied cookies, the optional TON Connect account/device
// and the optional redact list. Errors name the file and the entry number, never a value.

const COOKIE_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Control characters are checked by code point (a regex literal with them is a lint error).
const hasForbiddenChar = (value: string): boolean =>
  [...value].some((ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f || ch === ';';
  });

const BOM = String.fromCharCode(0xfeff);
const stripBom = (text: string): string => (text.startsWith(BOM) ? text.slice(1) : text);

/** A copied `Cookie:` header line, or `name=value` pairs separated by `;` or new lines. */
export function parseCookieFile(text: string): Map<string, string> {
  const body = stripBom(text).replace(/^\s*cookie\s*:/i, '');
  const jar = new Map<string, string>();
  const entries = body
    .split(/[;\r\n]+/)
    .map((e) => e.trim())
    .filter((e) => e !== '' && !e.startsWith('#'));
  entries.forEach((entry, index) => {
    const eq = entry.indexOf('=');
    const name = eq > 0 ? entry.slice(0, eq).trim() : '';
    const value = eq > 0 ? entry.slice(eq + 1).trim() : '';
    if (!COOKIE_NAME_RE.test(name) || value === '' || hasForbiddenChar(value)) {
      throw new RecordUsageError(`cookies file: entry ${index + 1} is not name=value`);
    }
    jar.set(name, value);
  });
  if (jar.size === 0) throw new RecordUsageError('cookies file: no cookies found');
  return jar;
}

const JsonObject = z.record(z.string(), z.unknown());
const objectOrJsonString = z.union([
  JsonObject,
  z.string().transform((text, ctx) => {
    try {
      return JsonObject.parse(JSON.parse(text));
    } catch {
      ctx.addIssue({ code: 'custom', message: 'not a JSON object' });
      return z.NEVER;
    }
  }),
]);

/** TON Connect DeviceInfo, strict (S-11): any other key (e.g. a session secret) is refused. */
const FeatureSchema = z.union([
  z.string().max(64),
  z
    .object({
      name: z.string().max(64),
      maxMessages: z.number().int().optional(),
      types: z.array(z.string().max(64)).optional(),
      extraCurrencySupported: z.boolean().optional(),
    })
    .strict(),
]);
const DeviceSchema = z
  .object({
    platform: z.string().max(32),
    appName: z.string().max(64),
    appVersion: z.string().max(32),
    maxProtocolVersion: z.number().int(),
    features: z.array(FeatureSchema).max(16),
  })
  .strict();

const TonConnectFileSchema = z
  .object({
    account: objectOrJsonString.pipe(
      z.object({
        address: z.string().min(1),
        chain: z.string().optional(),
        publicKey: z.string().optional(),
        walletStateInit: z.string().optional(),
      }),
    ),
    device: objectOrJsonString.pipe(DeviceSchema).optional(),
  })
  .strict();

export interface TonConnectInfo {
  readonly address: string;
  readonly publicKey: string | null;
  readonly walletStateInit: string | null;
  /** Sent as the `account` / `device` form fields of getBuyStarsLink (guess, docs). */
  readonly accountJson: string;
  readonly deviceJson: string | null;
}

/** The TON Connect `account` (+ `device`) the browser sent with getBuyStarsLink; public data. */
export function parseTonConnectFile(text: string): TonConnectInfo {
  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(text));
  } catch {
    throw new RecordUsageError('ton-connect file: not JSON');
  }
  const parsed = TonConnectFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RecordUsageError(
      'ton-connect file: needs account.address; device may hold only DeviceInfo keys',
    );
  }
  const { account, device } = parsed.data;
  if (parseTonAddress(account.address) === null) {
    throw new RecordUsageError('ton-connect file: account.address is not a TON address');
  }
  return {
    address: account.address,
    publicKey: account.publicKey ?? null,
    walletStateInit: account.walletStateInit ?? null,
    accountJson: JSON.stringify(account),
    deviceJson: device === undefined ? null : JSON.stringify(device),
  };
}

export interface RedactList {
  readonly texts: string[];
  /** Lines that are TON addresses: redacted in every address form (S-3). */
  readonly addresses: string[];
  /** Lines that look like a phone number: redacted whatever separates the digits (R-9). */
  readonly phones: string[];
}

const PHONE_LINE = /^\+?[\d\s().-]+$/;
const isPhone = (line: string): boolean =>
  PHONE_LINE.test(line) && line.replace(/\D/g, '').length >= 7;

/** Extra strings to redact, one per line (`#` starts a comment); each at least 3 characters. */
export function parseRedactFile(text: string): RedactList {
  const lines = stripBom(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  lines.forEach((line, index) => {
    if (line.length < 3) throw new RecordUsageError(`redact file: entry ${index + 1} is too short`);
  });
  const address = (line: string): boolean => parseTonAddress(line) !== null;
  return {
    texts: lines.filter((line) => !address(line) && !isPhone(line)),
    addresses: lines.filter(address),
    phones: lines.filter((line) => !address(line) && isPhone(line)),
  };
}
