import { nameWords, type SecretValue } from './secret-forms';
import { containsAtAnyBitShift, parseTonAddress } from './ton-address-forms';

// Base64 inside a recorded text (S-4): a BOC payload, a `ton://transfer/...?bin=` link, or a
// value wrapped over several lines. A BOC is always redacted (its text can be split across cells,
// so "no secret inside" cannot be proved: fail closed). Any other base64 run is decoded and
// redacted when a known secret (or a known account hash at any bit offset) is inside.

const BOC_MAGIC = Buffer.from([0xb5, 0xee, 0x9c, 0x72]);
const LINE_BREAK = /\r?\n|\\r\\n|\\n/g;
// Runs of base64 characters, possibly broken by (escaped) line breaks.
const RUN = /[A-Za-z0-9+/_-]{4,}(?:(?:\r?\n|\\r\\n|\\n)[A-Za-z0-9+/_-]{4,})*={0,2}/g;
const MIN_RUN = 24;

export interface PayloadNeedles {
  readonly texts: readonly string[];
  readonly hashes: readonly Buffer[];
}

const NEEDLE_KINDS = new Set(['name', 'username', 'tg_id', 'phone', 'secret', 'recipient']);

export function payloadNeedles(secrets: readonly SecretValue[]): PayloadNeedles {
  const texts = new Set<string>();
  const hashes: Buffer[] = [];
  for (const secret of secrets) {
    const value = secret.value.trim();
    if (secret.kind === 'address') {
      const id = parseTonAddress(value);
      if (id !== null) hashes.push(id.hash);
      continue;
    }
    if (!NEEDLE_KINDS.has(secret.kind) || value.length < 3) continue;
    texts.add(value.toLowerCase());
    if (secret.kind === 'name' || secret.kind === 'secret') {
      for (const word of nameWords(value)) texts.add(word.toLowerCase());
    }
  }
  return { texts: [...texts], hashes };
}

/** Drops C0/C1 control characters (cell descriptors between the chunks of a split comment). */
const printable = (text: string): string =>
  [...text]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && (code < 0x7f || code > 0x9f);
    })
    .join('');

/** True when the decoded bytes are a BOC or carry a needle. */
export function payloadIsSensitive(bytes: Buffer, needles: PayloadNeedles): boolean {
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(BOC_MAGIC)) return true;
  if (needles.hashes.some((hash) => containsAtAnyBitShift(bytes, hash))) return true;
  const views = [bytes.toString('latin1'), bytes.toString('utf8')].map((v) => v.toLowerCase());
  const all = [...views, ...views.map(printable)];
  return needles.texts.some((needle) => all.some((view) => view.includes(needle)));
}

/** Replaces sensitive base64 runs in `text` with `replacement`. */
export function redactPayloads(text: string, needles: PayloadNeedles, replacement: string): string {
  const redactRun = (run: string): string => {
    const joined = run.replace(LINE_BREAK, '');
    if (joined.length < MIN_RUN) return run;
    if (parseTonAddress(joined) !== null) return run; // addresses: the address rule decides
    if (!payloadIsSensitive(Buffer.from(joined, 'base64'), needles)) return run;
    // A URL path such as `tonviewer.com/UQ...` is not one payload: when a piece between the
    // slashes is an address, each piece is judged alone (the address rule then redacts it).
    const pieces = run.split('/');
    if (pieces.length > 1 && pieces.some((p) => parseTonAddress(p) !== null)) {
      return pieces.map(redactRun).join('/');
    }
    return replacement;
  };
  return text.replace(RUN, redactRun);
}
