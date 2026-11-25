import { describe, expect, it } from 'vitest';
import {
  NeedsReviewProofSchema,
  TON_BOUNCE_FEE_MAX_NANO,
  proofIsOperatorOnly,
  proofJustifies,
  proofNeedsOwnerOtp,
} from './review-proof';

// The three owner-only refund proofs of D-59 (A1 TON_BOUNCED, A2 TON_NOT_DEBITED, A3
// TON_UNMATCHED_RESOLVED) and who may carry which proof. The other proofs: review-proof.test.ts.

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

const tonTx = {
  kind: 'TON_TX',
  extMsgHash: 'a'.repeat(64),
  walletAddress: '0:' + 'b'.repeat(64),
  txHash: 'c'.repeat(64),
  lt: '48123456000001',
  reason: 'found the outgoing message in the wallet history',
} as const;

const notSent = {
  kind: 'TON_NOT_SENT',
  extMsgHash: 'a'.repeat(64),
  walletAddress: '0:' + 'b'.repeat(64),
  seqno: 41,
  validUntil: '2026-11-11T10:01:00.000Z',
  checkedSeqno: 41,
  checkedAt: '2026-11-11T10:02:00.000Z',
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

const ALL = [tonTx, notSent, notDebited, bounced, unmatched, fragment, manual] as const;
const parse = (value: unknown) => NeedsReviewProofSchema.safeParse(value);

describe('TON_BOUNCED (owner decision A1, D-59)', () => {
  it('names the transfer, our transaction, the bounce and a positive amount in nanoTON', () => {
    expect(parse(bounced).success).toBe(true);
    for (const key of Object.keys(bounced).filter((k) => k !== 'kind')) {
      const { [key as keyof typeof bounced]: _gone, ...without } = bounced;
      expect(parse(without).success, `without ${key}`).toBe(false);
    }
    for (const returnedNanoTon of ['0', '-1', '', '1.5', '01', 234000000, 1n, '9'.repeat(20)]) {
      expect(parse({ ...bounced, returnedNanoTon }).success, String(returnedNanoTon)).toBe(false);
    }
    for (const bad of ['', 'abc', 'A'.repeat(64)]) {
      expect(parse({ ...bounced, txHash: bad }).success, bad).toBe(false);
      expect(parse({ ...bounced, returnTxHash: bad }).success, bad).toBe(false);
    }
    for (const lt of ['-1', '1.5', 1, '1'.repeat(21)]) {
      expect(parse({ ...bounced, txLt: lt }).success, String(lt)).toBe(false);
      expect(parse({ ...bounced, returnLt: lt }).success, String(lt)).toBe(false);
    }
  });

  it('the bounce comes after our transaction and is another transaction (audit L7: returnLt = 0)', () => {
    expect(parse({ ...bounced, returnLt: '0' }).success).toBe(false);
    expect(parse({ ...bounced, returnLt: bounced.txLt }).success).toBe(false);
    expect(parse({ ...bounced, returnLt: '48123456000002' }).success).toBe(true);
    expect(parse({ ...bounced, returnTxHash: bounced.txHash }).success).toBe(false);
  });

  it('the old field names of the ONCHAIN_FAILED design are gone', () => {
    const { txHash, txLt, ...rest } = bounced;
    expect(parse({ ...rest, failedTxHash: txHash, failedLt: txLt }).success).toBe(false);
  });

  it('refunds only: it never delivers', () => {
    expect(proofJustifies(bounced, 'FAILED')).toBe(true);
    expect(proofJustifies(bounced, 'DELIVERED')).toBe(false);
  });

  it('the fee ceiling is a positive bigint below one TON', () => {
    expect(TON_BOUNCE_FEE_MAX_NANO).toBeGreaterThan(0n);
    expect(TON_BOUNCE_FEE_MAX_NANO).toBeLessThan(1_000_000_000n);
  });
});

describe('TON_NOT_DEBITED (owner decision A2, D-59)', () => {
  it('names the transfer and OUR failed transaction, and says there was no outgoing message', () => {
    expect(parse(notDebited).success).toBe(true);
    for (const key of Object.keys(notDebited).filter((k) => k !== 'kind')) {
      const { [key as keyof typeof notDebited]: _gone, ...without } = notDebited;
      expect(parse(without).success, `without ${key}`).toBe(false);
    }
  });

  it('outMsgCount is the literal 0: a transaction with an outgoing message is not this proof', () => {
    for (const outMsgCount of [1, 2, -1, '0', null, false, 0.5]) {
      expect(parse({ ...notDebited, outMsgCount }).success, String(outMsgCount)).toBe(false);
    }
  });

  it('carries no return transaction: nothing came back because nothing left', () => {
    expect(parse({ ...notDebited, returnTxHash: 'e'.repeat(64) }).success).toBe(false);
    expect(parse({ ...notDebited, txHash: 'xyz' }).success).toBe(false);
  });

  it('refunds only: it never delivers', () => {
    expect(proofJustifies(notDebited, 'FAILED')).toBe(true);
    expect(proofJustifies(notDebited, 'DELIVERED')).toBe(false);
  });
});

describe('TON_UNMATCHED_RESOLVED (owner decision A3, D-59)', () => {
  it('names the transfer, the finding, the consuming transaction and a real reason', () => {
    expect(parse(unmatched).success).toBe(true);
    expect(parse({ ...unmatched, finding: 'SENT_ELSEWHERE' }).success).toBe(true);
    for (const key of Object.keys(unmatched).filter((k) => k !== 'kind')) {
      const { [key as keyof typeof unmatched]: _gone, ...without } = unmatched;
      expect(parse(without).success, `without ${key}`).toBe(false);
    }
  });

  it('refuses a finding outside the two, a malformed hash and a one-word reason', () => {
    for (const finding of ['SENT', 'DELIVERED', '', 'not_sent', null]) {
      expect(parse({ ...unmatched, finding }).success, String(finding)).toBe(false);
    }
    for (const consumingTxHash of ['', 'abc', 'A'.repeat(64), 'a'.repeat(63)]) {
      expect(parse({ ...unmatched, consumingTxHash }).success, consumingTxHash).toBe(false);
    }
    for (const reason of ['', 'checked', 'x'.repeat(19), '   '.repeat(10), 'x'.repeat(501)]) {
      expect(parse({ ...unmatched, reason }).success, reason).toBe(false);
    }
    expect(parse({ ...unmatched, reason: 'x'.repeat(20) }).success).toBe(true);
  });

  it('refunds only: it never delivers', () => {
    expect(proofJustifies(unmatched, 'FAILED')).toBe(true);
    expect(proofJustifies(unmatched, 'DELIVERED')).toBe(false);
  });
});

describe('who may carry which proof', () => {
  it('the refunds of an unclear payout and a manual decision need an OWNER with the OTP', () => {
    const needs = ALL.filter((p) => proofNeedsOwnerOtp(p)).map((p) => p.kind);
    expect(needs).toEqual(['TON_NOT_DEBITED', 'TON_BOUNCED', 'TON_UNMATCHED_RESOLVED', 'MANUAL']);
  });

  it('the reconciler may carry only the proofs the chain itself backs', () => {
    const reconciler = ALL.filter((p) => !proofIsOperatorOnly(p)).map((p) => p.kind);
    expect(reconciler).toEqual(['TON_TX', 'TON_NOT_SENT']);
  });
});
