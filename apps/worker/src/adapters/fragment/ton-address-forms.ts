// Text forms of a TON address, for redaction only (no signing, no network, no TON library).
// One account has a raw form `wc:hex64` and user-friendly base64 forms (36 bytes: flags, wc,
// 32-byte hash, CRC16-XMODEM) that differ by the bounceable/testnet flags and the base64 alphabet.
// A fixture must lose every one of them, so the sanitizer redacts all forms of a known address.

const FRIENDLY_RE = /^[A-Za-z0-9+/_-]{48}$/;
const RAW_RE = /^(-?\d{1,3}):([0-9a-fA-F]{64})$/;

const BOUNCEABLE = 0x11;
const NON_BOUNCEABLE = 0x51;
const TESTNET = 0x80;

export interface TonAccountId {
  readonly workchain: number;
  readonly hash: Buffer;
}

function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** The account behind any raw or user-friendly form; null when the text is not an address. */
export function parseTonAddress(text: string): TonAccountId | null {
  const raw = RAW_RE.exec(text);
  if (raw !== null) {
    const workchain = Number(raw[1]);
    const hex = raw[2];
    if (hex === undefined || workchain < -128 || workchain > 127) return null;
    return { workchain, hash: Buffer.from(hex, 'hex') };
  }
  if (!FRIENDLY_RE.test(text)) return null;
  const bytes = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (bytes.length !== 36) return null;
  const tag = (bytes[0] ?? 0) & ~TESTNET;
  if (tag !== BOUNCEABLE && tag !== NON_BOUNCEABLE) return null;
  if (crc16(bytes.subarray(0, 34)) !== bytes.readUInt16BE(34)) return null;
  return { workchain: bytes.readInt8(1), hash: Buffer.from(bytes.subarray(2, 34)) };
}

function friendly(id: TonAccountId, tag: number): Buffer {
  const body = Buffer.alloc(36);
  body[0] = tag;
  body.writeInt8(id.workchain, 1);
  id.hash.copy(body, 2);
  body.writeUInt16BE(crc16(body.subarray(0, 34)), 34);
  return body;
}

/** Every text form of the account: raw (both hex cases) and 4 flag sets x 2 alphabets. */
export function tonAddressForms(id: TonAccountId): string[] {
  const hex = id.hash.toString('hex');
  const forms = new Set<string>([`${id.workchain}:${hex}`, `${id.workchain}:${hex.toUpperCase()}`]);
  for (const tag of [BOUNCEABLE, NON_BOUNCEABLE, BOUNCEABLE | TESTNET, NON_BOUNCEABLE | TESTNET]) {
    const bytes = friendly(id, tag);
    forms.add(bytes.toString('base64'));
    forms.add(bytes.toString('base64url'));
  }
  return [...forms];
}

/**
 * `needle` inside `haystack` at any of the 8 bit offsets: a BOC packs an address hash right after
 * a few flag bits, so it is rarely byte-aligned.
 */
export function containsAtAnyBitShift(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false;
  const bytes = Buffer.from(haystack);
  const target = Buffer.from(needle);
  if (bytes.includes(target)) return true;
  for (let shift = 1; shift < 8; shift += 1) {
    const shifted = Buffer.alloc(bytes.length - 1);
    for (let i = 0; i < shifted.length; i += 1) {
      shifted[i] = (((bytes[i] ?? 0) << shift) | ((bytes[i + 1] ?? 0) >> (8 - shift))) & 0xff;
    }
    if (shifted.includes(target)) return true;
  }
  return false;
}

/** Same account (any form on either side). */
export function sameTonAccount(a: TonAccountId, b: TonAccountId): boolean {
  return a.workchain === b.workchain && a.hash.equals(b.hash);
}
