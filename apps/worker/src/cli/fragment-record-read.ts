import { z } from 'zod';
import { parseTonAddress } from '../adapters/fragment/ton-address-forms';

// What the recorder needs from a response to take the next step. The shapes are GUESSES
// (docs/suppliers/fragment.md, "taxmin") until the recording confirms them; a response that does
// not match makes the next step skipped, never guessed around.

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

const FoundSchema = z.object({
  found: z.object({
    recipient: z.string().min(1),
    name: z.string().optional(),
    photo: z.string().optional(),
  }),
});

export interface FoundRecipient {
  readonly recipient: string;
  readonly name: string | null;
  readonly photo: string | null;
}

/** searchStarsRecipient → `found.recipient` (+ display name and photo HTML, if present). */
export function readFound(body: string): FoundRecipient | null {
  const parsed = FoundSchema.safeParse(json(body));
  if (!parsed.success) return null;
  const { recipient, name, photo } = parsed.data.found;
  return { recipient, name: name ?? null, photo: photo ?? null };
}

const ReqIdSchema = z.object({ req_id: z.union([z.string().min(1), z.number().int()]) });

/** initBuyStarsRequest → `req_id`. */
export function readReqId(body: string): string | null {
  const parsed = ReqIdSchema.safeParse(json(body));
  if (!parsed.success) return null;
  const id = String(parsed.data.req_id);
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

const LinkSchema = z.object({
  transaction: z.object({
    messages: z.array(z.object({ address: z.string() })),
  }),
});

const PayloadSchema = z.object({
  transaction: z.object({ messages: z.array(z.object({ payload: z.string().optional() })) }),
});

/** What the summary may say about a payload without showing it (it is always redacted). */
export interface PayloadInfo {
  readonly bytes: number;
  readonly bocMagic: boolean;
}

/** getBuyStarsLink → size and BOC magic of each message payload. */
export function readPayloadInfo(body: string): PayloadInfo[] {
  const parsed = PayloadSchema.safeParse(json(body));
  if (!parsed.success) return [];
  return parsed.data.transaction.messages.flatMap((m) => {
    if (m.payload === undefined) return [];
    const bytes = Buffer.from(m.payload.replace(/\s+/g, ''), 'base64');
    return [{ bytes: bytes.length, bocMagic: bytes.subarray(0, 4).toString('hex') === 'b5ee9c72' }];
  });
}

/** getBuyStarsLink → the destination addresses (Fragment's, public, kept in fixtures; Q7). */
export function readPayAddresses(body: string): string[] {
  const parsed = LinkSchema.safeParse(json(body));
  if (!parsed.success) return [];
  return parsed.data.transaction.messages
    .map((m) => m.address)
    .filter((address) => parseTonAddress(address) !== null);
}

/** getBuyStarsLink → how many messages the transaction holds (R-4 expects exactly one). */
export function readMessageCount(body: string): number {
  const parsed = LinkSchema.safeParse(json(body));
  return parsed.success ? parsed.data.transaction.messages.length : 0;
}

const FromSchema = z.object({ transaction: z.object({ from: z.string() }) });

/** getBuyStarsLink → `transaction.from`, the connected wallet: always a secret (audit KEEP1). */
export function readFromAddress(body: string): string | null {
  const parsed = FromSchema.safeParse(json(body));
  if (!parsed.success) return null;
  return parseTonAddress(parsed.data.transaction.from) === null
    ? null
    : parsed.data.transaction.from;
}
