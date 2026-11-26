import { describe, expect, it } from 'vitest';
import {
  NeedsReviewProofSchema,
  TON_NOT_SENT_MARGIN_MS,
  proofJustifies,
  type NeedsReviewOutcome,
  type NeedsReviewProof,
} from './review-proof';

const EXT = 'a'.repeat(64);
const WALLET = '0:' + 'b'.repeat(64);

const tonTx = {
  kind: 'TON_TX',
  extMsgHash: EXT,
  walletAddress: WALLET,
  txHash: 'c'.repeat(64),
  lt: '48123456000001',
  reason: 'found the outgoing message in the wallet history',
} as const;

const VALID_UNTIL = '2026-11-11T10:01:00.000Z';
const AFTER_MARGIN = new Date(Date.parse(VALID_UNTIL) + TON_NOT_SENT_MARGIN_MS).toISOString();

const notSent = {
  kind: 'TON_NOT_SENT',
  extMsgHash: EXT,
  walletAddress: WALLET,
  seqno: 41,
  validUntil: VALID_UNTIL,
  checkedSeqno: 41,
  checkedAt: AFTER_MARGIN,
  reason: 'message expired and the wallet seqno never moved',
} as const;

const fragment = {
  kind: 'FRAGMENT_STATUS',
  requestRef: 'req_9Zq',
  status: 'DONE',
  observedAt: '2026-11-11T10:06:00.000Z',
  reason: 'Fragment shows the order as completed',
} as const;

const manual = {
  kind: 'MANUAL',
  evidence: 'Telegram receipt for 50 Stars, screenshot kept by the owner',
  reason: 'recipient confirmed the Stars arrived',
} as const;

const bounced = {
  kind: 'TON_BOUNCED',
  transferId: 'transfer_1',
  txHash: 'd'.repeat(64),
  txLt: '48123456000001',
  returnTxHash: 'e'.repeat(64),
  returnLt: '48123456000009',
  returnedNanoTon: '234000000',
  reason: 'the bounce is in the wallet history, checked on two explorers',
} as const;

const notDebited = {
  kind: 'TON_NOT_DEBITED',
  transferId: 'transfer_1',
  txHash: 'd'.repeat(64),
  txLt: '48123456000001',
  outMsgCount: 0,
  reason: 'the action phase failed: the transaction has no outgoing message',
} as const;

const unmatched = {
  kind: 'TON_UNMATCHED_RESOLVED',
  transferId: 'transfer_1',
  finding: 'NOT_SENT',
  consumingTxHash: '9'.repeat(64),
  reason: 'seqno 41 was used by a wallet self-test that moved no value',
} as const;

const ALL = [tonTx, notSent, notDebited, bounced, unmatched, fragment, manual] as const;
const parse = (value: unknown) => NeedsReviewProofSchema.safeParse(value);

describe('NeedsReviewProofSchema', () => {
  it('accepts each of the seven variants', () => {
    for (const proof of ALL) expect(parse(proof).success, proof.kind).toBe(true);
  });

  it('every variant names its reason: removing it or blanking it is refused', () => {
    for (const proof of ALL) {
      const { reason: _reason, ...withoutReason } = proof;
      expect(parse(withoutReason).success, `${proof.kind} without reason`).toBe(false);
      expect(parse({ ...proof, reason: '   ' }).success, `${proof.kind} blank reason`).toBe(false);
    }
  });

  it('carries no actor: who signs is the resolver parameter, never a field a caller can write', () => {
    for (const proof of ALL) {
      for (const actor of ['reconciler', 'admin', 'system']) {
        expect(parse({ ...proof, actor }).success, `${proof.kind} actor ${actor}`).toBe(false);
      }
    }
  });

  it('MANUAL needs evidence text, not just a reason', () => {
    expect(parse({ ...manual, evidence: '' }).success).toBe(false);
    expect(parse({ ...manual, evidence: '  ' }).success).toBe(false);
    expect(parse({ ...manual, evidence: 'x'.repeat(1001) }).success).toBe(false);
  });

  it('TON proofs name the message and the wallet they are about (binding to the order)', () => {
    for (const proof of [tonTx, notSent]) {
      for (const key of ['extMsgHash', 'walletAddress'] as const) {
        const { [key]: _gone, ...without } = proof;
        expect(parse(without).success, `${proof.kind} without ${key}`).toBe(false);
        expect(parse({ ...proof, [key]: '' }).success, `${proof.kind} empty ${key}`).toBe(false);
      }
    }
  });

  it('TON_NOT_SENT proves nothing unless the seqno is unchanged and the check is past the margin', () => {
    expect(parse({ ...notSent, checkedSeqno: 42 }).success).toBe(false);
    expect(parse({ ...notSent, checkedSeqno: 40 }).success).toBe(false);
    // Checked before the message expired: it could still be accepted later.
    expect(parse({ ...notSent, checkedAt: '2026-11-11T10:00:59.999Z' }).success).toBe(false);
    // Just after validUntil but inside the margin: not yet a proof.
    expect(parse({ ...notSent, checkedAt: '2026-11-11T10:01:00.001Z' }).success).toBe(false);
    const justBefore = new Date(Date.parse(AFTER_MARGIN) - 1).toISOString();
    expect(parse({ ...notSent, checkedAt: justBefore }).success).toBe(false);
    // Exactly validUntil + margin is enough.
    expect(parse({ ...notSent, checkedAt: AFTER_MARGIN }).success).toBe(true);
  });

  it('TON_NOT_SENT bounds seqno to a non-negative 31-bit integer', () => {
    expect(parse({ ...notSent, seqno: 0, checkedSeqno: 0 }).success).toBe(true);
    expect(parse({ ...notSent, seqno: -1, checkedSeqno: -1 }).success).toBe(false);
    expect(parse({ ...notSent, seqno: 1.5, checkedSeqno: 1.5 }).success).toBe(false);
    expect(parse({ ...notSent, seqno: 2 ** 31, checkedSeqno: 2 ** 31 }).success).toBe(false);
  });

  it('TON_TX takes the logical time as a decimal string: a number or a bigint is not JSON-safe', () => {
    expect(parse({ ...tonTx, lt: 48123456000001 }).success).toBe(false);
    expect(parse({ ...tonTx, lt: 1n }).success).toBe(false);
    expect(parse({ ...tonTx, lt: '-1' }).success).toBe(false);
    expect(parse({ ...tonTx, lt: '1'.repeat(21) }).success).toBe(false);
    expect(parse({ ...tonTx, txHash: '' }).success).toBe(false);
  });

  it('a logical time is written in canonical form: a leading zero is refused (the DB compares text)', () => {
    expect(parse({ ...tonTx, lt: '0099' }).success).toBe(false);
    expect(parse({ ...notDebited, txLt: '0099' }).success).toBe(false);
    expect(parse({ ...bounced, returnLt: '048123456000009' }).success).toBe(false);
    expect(parse({ ...tonTx, lt: '99' }).success).toBe(true);
    expect(parse({ ...tonTx, lt: '0' }).success).toBe(true);
  });

  it('FRAGMENT_STATUS has no "failed": that never proves our payment stayed home', () => {
    expect(parse({ ...fragment, status: 'FAILED' }).success).toBe(false);
  });

  it('refuses an unknown kind, an extra key and a missing proof', () => {
    expect(parse({ ...tonTx, kind: 'WHATEVER' }).success).toBe(false);
    expect(parse({ ...tonTx, extra: 1 }).success).toBe(false);
    expect(parse({ ...notSent, extra: 1 }).success).toBe(false);
    for (const nothing of [undefined, null, {}, '', 'TON_TX', []]) {
      expect(parse(nothing).success).toBe(false);
    }
  });

  it('refuses control characters in free text (the proof is stored and shown to an operator)', () => {
    expect(parse({ ...tonTx, reason: 'a\u0000b' }).success).toBe(false);
    expect(parse({ ...manual, evidence: 'a\nb' }).success).toBe(false);
    expect(parse({ ...fragment, requestRef: 'a\tb' }).success).toBe(false);
  });
});

describe('proofJustifies: which proof may justify which exit', () => {
  const proofs: readonly NeedsReviewProof[] = ALL;
  const matrix: Readonly<Record<NeedsReviewOutcome, readonly string[]>> = {
    DELIVERED: ['TON_TX', 'FRAGMENT_STATUS', 'MANUAL'],
    FAILED: ['TON_NOT_SENT', 'TON_NOT_DEBITED', 'TON_BOUNCED', 'TON_UNMATCHED_RESOLVED', 'MANUAL'],
  };

  it.each(['DELIVERED', 'FAILED'] as const)('%s', (outcome) => {
    const allowed = proofs.filter((p) => proofJustifies(p, outcome)).map((p) => p.kind);
    expect(allowed).toEqual(proofs.map((p) => p.kind).filter((k) => matrix[outcome].includes(k)));
  });

  it('"sent" evidence never refunds, and "not sent" evidence never delivers', () => {
    expect(proofJustifies(tonTx, 'FAILED')).toBe(false);
    expect(proofJustifies(fragment, 'FAILED')).toBe(false);
    expect(proofJustifies(notSent, 'DELIVERED')).toBe(false);
  });
});

describe('the proof speaks the one stored spelling of TON identifiers (audit M2, N6)', () => {
  it('a wallet that is not a raw 0:/-1: address is not a proof, whatever its spelling', () => {
    for (const walletAddress of [
      '00:' + 'b'.repeat(64),
      '000:' + 'b'.repeat(64),
      '-0:' + 'b'.repeat(64),
      '1:' + 'b'.repeat(64),
      'EQCrq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq8Uk',
    ]) {
      expect(parse({ ...tonTx, walletAddress }).success, walletAddress).toBe(false);
      expect(parse({ ...notSent, walletAddress }).success, walletAddress).toBe(false);
    }
    expect(parse({ ...tonTx, walletAddress: '-1:' + 'b'.repeat(64) }).success).toBe(true);
  });

  it('message and transaction hashes are 64 lowercase hex', () => {
    for (const bad of ['', 'abc', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'tx-1']) {
      expect(parse({ ...tonTx, extMsgHash: bad }).success, `ext ${bad}`).toBe(false);
      expect(parse({ ...tonTx, txHash: bad }).success, `tx ${bad}`).toBe(false);
      expect(parse({ ...notSent, extMsgHash: bad }).success, `ext ${bad}`).toBe(false);
    }
  });
});
