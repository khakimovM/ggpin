import { TON_NOT_SENT_MARGIN_MS } from '@repo/shared';
import type { Prisma } from '../src/index';

// Proofs and resolvers for the NEEDS_REVIEW tests: well-formed proofs built from a transfer row,
// and the two kinds of resolver. Re-exported by order-fixtures.ts.

let hashCounter = 0;
/** A 64-hex hash nobody else uses (the return and consuming transactions are not our own). */
export const uniqueHash = (): string =>
  (0x7000_0000 + ++hashCounter).toString(16).padStart(64, 'f');

/** The columns of a TonTransfer row that a proof is built from. */
interface Transfer {
  readonly id: string;
  readonly extMsgHash: string;
  readonly walletAddress: string;
  readonly txHash: string | null;
  readonly txLt: bigint | null;
  readonly seqno: number;
  readonly validUntil: Date;
  readonly amountNanoTon: bigint;
}

export const tonTxProof = (transfer: Transfer, overrides: Record<string, unknown> = {}) => ({
  kind: 'TON_TX',
  extMsgHash: transfer.extMsgHash,
  walletAddress: transfer.walletAddress,
  txHash: transfer.txHash,
  lt: (transfer.txLt ?? 0n).toString(),
  reason: 'found the outgoing message in the wallet history',
  ...overrides,
});

export const notSentProof = (transfer: Transfer, overrides: Record<string, unknown> = {}) => ({
  kind: 'TON_NOT_SENT',
  extMsgHash: transfer.extMsgHash,
  walletAddress: transfer.walletAddress,
  seqno: transfer.seqno,
  validUntil: transfer.validUntil.toISOString(),
  checkedSeqno: transfer.seqno,
  checkedAt: new Date(transfer.validUntil.getTime() + TON_NOT_SENT_MARGIN_MS).toISOString(),
  reason: 'message expired and the wallet seqno never moved',
  ...overrides,
});

export const bouncedProof = (transfer: Transfer, overrides: Record<string, unknown> = {}) => ({
  kind: 'TON_BOUNCED',
  transferId: transfer.id,
  txHash: transfer.txHash,
  txLt: (transfer.txLt ?? 0n).toString(),
  // A fresh return transaction per proof: one bounce pays out one refund (audit R2e).
  returnTxHash: uniqueHash(),
  returnLt: ((transfer.txLt ?? 0n) + 6n).toString(),
  returnedNanoTon: (transfer.amountNanoTon - 5_000_000n).toString(),
  reason: 'the value came back to the wallet, seen in two explorers',
  ...overrides,
});

export const notDebitedProof = (transfer: Transfer, overrides: Record<string, unknown> = {}) => ({
  kind: 'TON_NOT_DEBITED',
  transferId: transfer.id,
  txHash: transfer.txHash,
  txLt: (transfer.txLt ?? 0n).toString(),
  outMsgCount: 0,
  reason: 'the action phase failed, the transaction has no outgoing message',
  ...overrides,
});

export const unmatchedProof = (transfer: Transfer, overrides: Record<string, unknown> = {}) => ({
  kind: 'TON_UNMATCHED_RESOLVED',
  transferId: transfer.id,
  finding: 'NOT_SENT',
  consumingTxHash: uniqueHash(),
  reason: 'seqno was used by a transaction that moved no value, checked in two explorers',
  ...overrides,
});

export const manualProof = {
  kind: 'MANUAL',
  evidence: 'Telegram receipt shown by the customer',
  reason: 'owner verified the receipt',
} as const;

export const RECONCILER = { kind: 'reconciler' } as const;
export const OPERATOR = {
  kind: 'operator',
  type: 'CLI',
  id: 'owner-1',
  ip: '10.0.0.1',
  osUser: 'aziz',
  otpVerified: true,
} as const;

/** The audit row `resolveNeedsReview` writes, built by hand for the tests of the SQL checks. */
export function resolveAuditData(
  orderId: string,
  proof: Prisma.InputJsonObject,
  options: {
    readonly role?: string;
    readonly otpVerified?: Prisma.InputJsonValue;
    /** The resolver type of the row: the owner CLI by default (TON_UNMATCHED_RESOLVED needs it). */
    readonly type?: string;
  } = {},
) {
  return {
    actorType: 'SYSTEM',
    action: 'ORDER_REVIEW_RESOLVE',
    targetType: 'Order',
    targetId: orderId,
    reason: 'test',
    after: {
      proof: { ...proof },
      resolver: 'operator',
      operator: { type: options.type ?? 'CLI', id: 'owner-1', role: options.role ?? 'OWNER' },
      otpVerified: options.otpVerified ?? true,
    },
  };
}
