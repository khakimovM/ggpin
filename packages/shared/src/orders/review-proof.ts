// The proof that moves an order out of NEEDS_REVIEW (docs/06 "Phase 5 majburiy talablari"): the
// state machine only says WHO may leave NEEDS_REVIEW, it cannot know WHETHER the payout happened.
// Without a proof neither NEEDS_REVIEW -> DELIVERED nor NEEDS_REVIEW -> FAILED (which refunds the
// customer) may run.
//
// A proof is a CLAIM about one payout, not a permission. `resolveNeedsReview` (@repo/db) binds it
// to the order's own rows under lock: the transfer it names must belong to this order's attempt
// and be in the matching state, the numbers must equal the stored ones, and no other live payout
// may exist. A proof that only agrees with itself is refused (audit finding H1).
//
// WHO signs is not in the proof: the resolver (the reconciler, or an operator with an id) is a
// separate, trusted parameter of the helper and is stored next to the proof in the audit row, so
// an adapter or a JSON blob cannot claim to be someone it is not (review F1, audit M3). Which
// proofs the reconciler may carry and which need an OWNER with the OTP is decided below
// (`proofIsOperatorOnly`, `proofNeedsOwnerOtp`; D-59).
//
// JSON only: bigint values (the logical time `lt`) travel as decimal strings because the proof is
// serialised into the audit row.
import { z } from 'zod';
import { NO_CONTROL_CHARS, ResourceIdSchema } from '../common-schemas';
import { RawTonAddressSchema, TonHashSchema } from './address-format';

const ReasonSchema = z.string().trim().min(1).max(500).regex(NO_CONTROL_CHARS);
const OpaqueRefSchema = z.string().min(1).max(256).regex(NO_CONTROL_CHARS);
const IsoTimeSchema = z.iso.datetime();
/**
 * Logical time of a transaction, a non-negative decimal string in canonical form (no leading zeros):
 * the DB check compares the proof's lt with the transfer's as text, so "0099" is refused here rather
 * than passing the helper and failing at COMMIT.
 */
const LOGICAL_TIME_PATTERN = /^(0|[1-9]\d{0,19})$/;
const LogicalTimeSchema = z.string().regex(LOGICAL_TIME_PATTERN);
const isLogicalTime = (value: unknown): value is string =>
  typeof value === 'string' && LOGICAL_TIME_PATTERN.test(value);
const NonNegativeIntSchema = z.number().int().min(0).max(2_147_483_647);

/**
 * How long after a message's `validUntil` the wallet must be checked before "it expired" is a
 * proof (plan 6.5: `validUntil + margin`, by chain time). It absorbs the gap between our clock,
 * the indexer's view and the validator's block time. Tuned against the testnet self-test (S12).
 * The database holds the same number in `ggpin_ton_not_sent_margin_ms()` and refuses to mark a
 * transfer EXPIRED earlier (audit N2); a test compares the two.
 */
export const TON_NOT_SENT_MARGIN_MS = 60_000;

/**
 * The most a bounce may cost (owner decision A1, D-59): a bounced payment returns the value minus
 * the gas of the aborted compute phase and the forward fees, so `returnedNanoTon` must lie in
 * `[sent - TON_BOUNCE_FEE_MAX_NANO, sent]`. Below that floor "the money came back" is not proven
 * (a refund on a 1 nanoTON bounce went through, audit L7). 0.05 TON is a deliberately
 * conservative guess (typical bounce losses are a few thousandths of a TON): it is replaced by the
 * figure observed in the S9 fixture of a real bounce. A bigger value only widens the accepted
 * range; the shortfall of a bounce is the company's loss, never the customer's.
 */
export const TON_BOUNCE_FEE_MAX_NANO = 50_000_000n;

/**
 * The payout is on the chain: the transfer `extMsgHash` of this order is CONFIRMED with this
 * transaction. Proves "sent", so it can only lead to DELIVERED.
 */
const tonTxProof = z.strictObject({
  kind: z.literal('TON_TX'),
  /** Normalized external message hash of OUR signed message (`TonTransfer.extMsgHash`). */
  extMsgHash: TonHashSchema,
  /** Raw form `<workchain>:<64 hex>`, the only spelling that is stored (audit M2, N6). */
  walletAddress: RawTonAddressSchema,
  txHash: TonHashSchema,
  /** Logical time of the transaction, a non-negative decimal string. */
  lt: LogicalTimeSchema,
  reason: ReasonSchema,
});

/**
 * The payout provably did NOT go out: the signed message (`extMsgHash`) expired (its `validUntil`
 * is past by at least the margin) while the wallet's seqno is still the one it was signed with,
 * so the message can never be accepted. Proves "not sent", so it can only lead to FAILED
 * (+ refund). The shape refuses a proof that proves nothing on its own; the helper then checks it
 * against the stored transfer (EXPIRED, same seqno and `validUntil`).
 */
const tonNotSentProof = z
  .strictObject({
    kind: z.literal('TON_NOT_SENT'),
    extMsgHash: TonHashSchema,
    walletAddress: RawTonAddressSchema,
    /** The seqno the lost message was signed with. */
    seqno: NonNegativeIntSchema,
    validUntil: IsoTimeSchema,
    /** The wallet's seqno read from the chain at `checkedAt`. */
    checkedSeqno: NonNegativeIntSchema,
    checkedAt: IsoTimeSchema,
    reason: ReasonSchema,
  })
  .refine(
    (proof) =>
      proof.checkedSeqno === proof.seqno &&
      new Date(proof.checkedAt).getTime() >=
        new Date(proof.validUntil).getTime() + TON_NOT_SENT_MARGIN_MS,
    {
      message:
        'seqno unchanged and checked at least the margin after validUntil, or nothing is proven',
    },
  );

/**
 * A transfer whose ACTION PHASE failed (ONCHAIN_FAILED, owner decision A2): our message was
 * accepted and its transaction exists, but it produced NO outgoing message, so the value never left
 * the wallet and there is nothing to bounce. Proves "not debited", so it can only lead to FAILED
 * (+ refund). It names the transfer and the failed transaction (hash and logical time, equal to the
 * stored ones) and says `outMsgCount: 0` literally: a transaction with an outgoing message is not
 * this proof. Only an OWNER who typed the OTP may carry it. That the transaction really has no
 * outgoing message is checked on the chain by S9/S10 (docs/06), not by the database.
 */
const tonNotDebitedProof = z.strictObject({
  kind: z.literal('TON_NOT_DEBITED'),
  /** `TonTransfer.id` of the failed transfer. */
  transferId: ResourceIdSchema,
  /** OUR failed transaction (equal to `TonTransfer.txHash` / `txLt`). */
  txHash: TonHashSchema,
  txLt: LogicalTimeSchema,
  outMsgCount: z.literal(0),
  reason: ReasonSchema,
});

/**
 * The destination aborted our message and the value CAME BACK (BOUNCED, owner decision A1): our
 * transaction succeeded and sent the message, the destination's transaction failed and a bounce
 * returned the money to the wallet in a transaction of its own. Proves "the money returned", so it
 * can only lead to FAILED (+ refund). `txHash` / `txLt` are OUR transaction (equal to the stored
 * ones), `returnTxHash` / `returnLt` the bounce (`returnLt` after `txLt`; one hash is never used
 * by a second refund: unique index on the audit rows), `returnedNanoTon` lies in
 * `[sent - TON_BOUNCE_FEE_MAX_NANO, sent]` (the helper checks it against the stored amount).
 * Only an OWNER who typed the OTP may carry it; the bounce itself is verified on the chain by
 * S9/S10 (two sources), not by the database.
 */
const tonBouncedProof = z
  .strictObject({
    kind: z.literal('TON_BOUNCED'),
    transferId: ResourceIdSchema,
    txHash: TonHashSchema,
    txLt: LogicalTimeSchema,
    returnTxHash: TonHashSchema,
    returnLt: LogicalTimeSchema,
    /** What came back, in nanoTON (a positive decimal string). */
    returnedNanoTon: z.string().regex(/^[1-9]\d{0,18}$/),
    reason: ReasonSchema,
  })
  // zod runs a refinement even when a field already failed, so a malformed time must not throw here.
  .refine(
    (proof) =>
      !isLogicalTime(proof.returnLt) ||
      !isLogicalTime(proof.txLt) ||
      BigInt(proof.returnLt) > BigInt(proof.txLt),
    {
      message: 'the bounce transaction comes after the transaction it returns',
      path: ['returnLt'],
    },
  )
  .refine((proof) => proof.returnTxHash !== proof.txHash, {
    message: 'the bounce is a different transaction from the message it returns',
    path: ['returnTxHash'],
  });

/**
 * The seqno of a transfer was consumed by a transaction that is not ours (CONSUMED_UNMATCHED) and a
 * human has since looked at the chain (owner decision A3, docs/06 runbook): `NOT_SENT` (the
 * consuming transaction moved no value out) or `SENT_ELSEWHERE` (value left to somewhere else: the
 * wallet is compromised, a security incident that raises its own critical alert). Either way OUR
 * message did not pay the recipient, so it can only lead to FAILED (+ refund; the loss is the
 * company's). `consumingTxHash` is the unknown transaction that used the seqno. Only an OWNER with
 * the OTP, only through the owner CLI (S10); no automatic path exists.
 */
const tonUnmatchedResolvedProof = z.strictObject({
  kind: z.literal('TON_UNMATCHED_RESOLVED'),
  transferId: ResourceIdSchema,
  finding: z.enum(['NOT_SENT', 'SENT_ELSEWHERE']),
  consumingTxHash: TonHashSchema,
  /** A finding of this weight needs a sentence, not a word. */
  reason: z.string().trim().min(20).max(500).regex(NO_CONTROL_CHARS),
});

/**
 * Fragment itself reports the request as done. Proves "sent", so it only leads to DELIVERED.
 * There is deliberately no "failed" status: Fragment saying a request failed does not prove that
 * our TON payment stayed in the wallet, so a refund needs TON_NOT_SENT (or an operator's MANUAL).
 * `requestRef` must equal the `externalRef` of one of the order's attempts.
 * PROVISIONAL: the endpoint that tells the status is not known yet (S0b spike, plan Q6); the
 * fields below are the minimum any such answer carries and are revisited with the fixtures.
 */
const fragmentStatusProof = z.strictObject({
  kind: z.literal('FRAGMENT_STATUS'),
  requestRef: OpaqueRefSchema,
  status: z.literal('DONE'),
  observedAt: IsoTimeSchema,
  reason: ReasonSchema,
});

/**
 * An operator decided with evidence the system cannot see (a Telegram receipt, a supplier
 * statement). Only an OWNER with a verified OTP may carry it (rules/60: a refund or a manual
 * delivery is a money-moving admin action), for either outcome, but the helper still refuses it
 * when the order's own rows show a payout that may have gone out (and a delivery needs a payout
 * that landed: `deliveryProblem`).
 */
const manualProof = z.strictObject({
  kind: z.literal('MANUAL'),
  evidence: z.string().trim().min(1).max(1000).regex(NO_CONTROL_CHARS),
  reason: ReasonSchema,
});

export const NeedsReviewProofSchema = z.discriminatedUnion('kind', [
  tonTxProof,
  tonNotSentProof,
  tonNotDebitedProof,
  tonBouncedProof,
  tonUnmatchedResolvedProof,
  fragmentStatusProof,
  manualProof,
]);
export type NeedsReviewProof = z.infer<typeof NeedsReviewProofSchema>;
export type NeedsReviewProofKind = NeedsReviewProof['kind'];

/** What the order becomes when it leaves NEEDS_REVIEW (the only two exits in order-state.ts). */
export type NeedsReviewOutcome = 'DELIVERED' | 'FAILED';

// Which proof may justify which exit. "Sent" evidence delivers, "not sent" evidence fails and
// refunds, MANUAL (an operator's own evidence) may do either. A proof of the wrong kind for the
// exit is refused, so a TON_TX can never be used to refund an order that was in fact paid out.
const PROOF_KINDS: Readonly<Record<NeedsReviewOutcome, readonly NeedsReviewProofKind[]>> =
  Object.freeze({
    DELIVERED: Object.freeze(['TON_TX', 'FRAGMENT_STATUS', 'MANUAL'] as const),
    FAILED: Object.freeze([
      'TON_NOT_SENT',
      'TON_NOT_DEBITED',
      'TON_BOUNCED',
      'TON_UNMATCHED_RESOLVED',
      'MANUAL',
    ] as const),
  });

/** True when `proof` is of a kind that may justify leaving NEEDS_REVIEW as `outcome`. */
export function proofJustifies(proof: NeedsReviewProof, outcome: NeedsReviewOutcome): boolean {
  return PROOF_KINDS[outcome].includes(proof.kind);
}

// Carrying a proof of these kinds needs an OWNER whose OTP was verified (rules/60: a refund or a
// manual delivery is a money-moving admin action). The proofs the chain itself backs (TON_TX,
// TON_NOT_SENT) and FRAGMENT_STATUS do not need the operator's OTP.
const OWNER_OTP_KINDS: readonly NeedsReviewProofKind[] = Object.freeze([
  'TON_NOT_DEBITED',
  'TON_BOUNCED',
  'TON_UNMATCHED_RESOLVED',
  'MANUAL',
]);

/** True when carrying this proof needs an OWNER resolver with `otpVerified === true`. */
export function proofNeedsOwnerOtp(proof: NeedsReviewProof): boolean {
  return OWNER_OTP_KINDS.includes(proof.kind);
}

/**
 * True when the reconciler may not carry this proof: the payout questions it cannot settle, and
 * FRAGMENT_STATUS, whose shape is still a guess (docs/06 open question) and which the reconciler
 * never uses on its own (audit choice 5, review Y4).
 */
export function proofIsOperatorOnly(proof: NeedsReviewProof): boolean {
  return proof.kind === 'FRAGMENT_STATUS' || proofNeedsOwnerOtp(proof);
}
