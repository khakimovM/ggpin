import type { Prisma } from '@repo/db';
import type { EvidenceContext, ReviewAttempt, ReviewTransfer } from '../review-evidence';

// Rows for the pure decision tests (review-evidence.spec.ts): one hot wallet on testnet, transfers
// signed at VALID_UNTIL, and the two observations the TON module keeps with an EXPIRED transfer.

export const WALLET = `0:${'a'.repeat(64)}`;
export const VALID_UNTIL = new Date('2026-11-16T10:00:00.000Z');
const VALID_UNTIL_MS = VALID_UNTIL.getTime();
const GAP_SEC = 30;

export const CONTEXT: EvidenceContext = {
  network: 'testnet',
  walletAddress: WALLET,
  expiryGapSec: GAP_SEC,
};

let counter = 0;
const hash = (seed: number): string => seed.toString(16).padStart(64, '0');

export function transfer(overrides: Partial<ReviewTransfer> = {}): ReviewTransfer {
  counter += 1;
  return {
    id: `tr${String(counter).padStart(22, '0')}`,
    purpose: 'ORDER',
    network: 'testnet',
    walletAddress: WALLET,
    seqno: 7,
    validUntil: VALID_UNTIL,
    extMsgHash: hash(1_000 + counter),
    status: 'EXPIRED',
    txHash: null,
    txLt: null,
    ...overrides,
  };
}

function observation(t: ReviewTransfer, atMs: number, chainTime: number): Prisma.InputJsonObject {
  return {
    transferId: t.id,
    extMsgHash: t.extMsgHash,
    validUntilMs: t.validUntil.getTime(),
    chainTime,
    atMs,
    seqno: t.seqno,
    lastTxLt: '500',
  };
}

/** The `{ first, second }` pair the TON module stores when it writes the transfer EXPIRED. */
export function expiryPair(t: ReviewTransfer, gapSec = GAP_SEC): Prisma.InputJsonObject {
  const firstAt = t.validUntil.getTime() + 61_000;
  const firstChain = Math.floor(t.validUntil.getTime() / 1_000) + 62;
  return {
    first: observation(t, firstAt, firstChain),
    second: observation(t, firstAt + gapSec * 1_000, firstChain + gapSec),
  };
}

export function attempt(
  t: ReviewTransfer | null,
  overrides: Partial<Omit<ReviewAttempt, 'transfer'>> & { ton?: Prisma.InputJsonObject } = {},
): ReviewAttempt {
  counter += 1;
  const { ton, ...rest } = overrides;
  const facts: Prisma.InputJsonObject =
    ton ?? (t !== null && t.status === 'EXPIRED' ? { expiry: expiryPair(t) } : { timeout: true });
  return {
    id: `at${String(counter).padStart(22, '0')}`,
    status: 'UNKNOWN',
    response: JSON.parse(JSON.stringify({ ton: facts })) as Prisma.JsonValue,
    transfer: t,
    ...rest,
  };
}

export function confirmed(overrides: Partial<ReviewTransfer> = {}): ReviewTransfer {
  return transfer({ status: 'CONFIRMED', txHash: hash(9_000 + counter), txLt: 777n, ...overrides });
}

export const CHECKED_AT = new Date(VALID_UNTIL_MS + 61_000 + GAP_SEC * 1_000).toISOString();
