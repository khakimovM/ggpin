// The proof the panel sends to leave NEEDS_REVIEW (`POST /admin/orders/:id/resolve`, D-59, D-63).
// A strict, per-kind copy of phase 5 `NeedsReviewProofSchema` (feat/p5-stars-order:
// packages/shared/src/orders/review-proof.ts) WITHOUT `reason` (the body's `reason` is copied
// into the proof by the server, the CLI's `parseProof` rule, so the audit row never carries two
// stories) and WITHOUT `TON_UNMATCHED_RESOLVED` (owner CLI only, D-59 (3)).
// The panel's text fields are STRICTER than phase 5 (one visible line: no bidi, zero-width or
// line separator, review N4), so the rule is "panel ⊂ phase 5": every proof the panel accepts,
// phase 5 accepts too. 9-B: a subset test against phase 5's export; until then the server
// re-parses the proof with phase 5's own schema before @repo/db binds it.
import { z } from 'zod';
import { NO_CONTROL_CHARS, ResourceIdSchema } from '../common-schemas';
import { adminSingleLine } from './admin-common-schemas';

/** Phase 5 `TON_HASH_PATTERN` / `RAW_TON_ADDRESS_PATTERN` (address-format.ts), copied for 9-A. */
const TonHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const RawTonAddressSchema = z.string().regex(/^(0|-1):[0-9a-f]{64}$/);
const LOGICAL_TIME_PATTERN = /^(0|[1-9]\d{0,19})$/;
const LogicalTimeSchema = z.string().regex(LOGICAL_TIME_PATTERN);
const isLogicalTime = (value: unknown): value is string =>
  typeof value === 'string' && LOGICAL_TIME_PATTERN.test(value);
const NonNegativeIntSchema = z.number().int().min(0).max(2_147_483_647);
const IsoTimeSchema = z.iso.datetime();
// Typed by the owner and kept in the audit proof: one visible line (phase 5 refuses every control
// character, `\n` included, and the panel accepts a subset of phase 5).
const OpaqueRefSchema = adminSingleLine(256).regex(NO_CONTROL_CHARS);
/** Phase 5 `TON_NOT_SENT_MARGIN_MS`: "expired" is a proof only this long after `validUntil`. */
const NOT_SENT_MARGIN_MS = 60_000;

export const ADMIN_RESOLVE_PROOF_KINDS = [
  'TON_TX',
  'TON_NOT_SENT',
  'TON_NOT_DEBITED',
  'TON_BOUNCED',
  'FRAGMENT_STATUS',
  'MANUAL',
] as const;

const tonTx = z.strictObject({
  kind: z.literal('TON_TX'),
  extMsgHash: TonHashSchema,
  walletAddress: RawTonAddressSchema,
  txHash: TonHashSchema,
  lt: LogicalTimeSchema,
});

const tonNotSent = z
  .strictObject({
    kind: z.literal('TON_NOT_SENT'),
    extMsgHash: TonHashSchema,
    walletAddress: RawTonAddressSchema,
    seqno: NonNegativeIntSchema,
    validUntil: IsoTimeSchema,
    checkedSeqno: NonNegativeIntSchema,
    checkedAt: IsoTimeSchema,
  })
  .refine(
    (p) =>
      p.checkedSeqno === p.seqno &&
      Date.parse(p.checkedAt) >= Date.parse(p.validUntil) + NOT_SENT_MARGIN_MS,
    { message: 'seqno unchanged and checked at least the margin after validUntil' },
  );

const tonNotDebited = z.strictObject({
  kind: z.literal('TON_NOT_DEBITED'),
  transferId: ResourceIdSchema,
  txHash: TonHashSchema,
  txLt: LogicalTimeSchema,
  outMsgCount: z.literal(0),
});

const tonBounced = z
  .strictObject({
    kind: z.literal('TON_BOUNCED'),
    transferId: ResourceIdSchema,
    txHash: TonHashSchema,
    txLt: LogicalTimeSchema,
    returnTxHash: TonHashSchema,
    returnLt: LogicalTimeSchema,
    returnedNanoTon: z.string().regex(/^[1-9]\d{0,18}$/),
  })
  // A refinement runs even when a field failed, so a malformed time must not throw in BigInt().
  .refine(
    (p) =>
      !isLogicalTime(p.returnLt) || !isLogicalTime(p.txLt) || BigInt(p.returnLt) > BigInt(p.txLt),
    { message: 'the bounce comes after the transaction it returns', path: ['returnLt'] },
  )
  .refine((p) => p.returnTxHash !== p.txHash, {
    message: 'the bounce is a different transaction',
    path: ['returnTxHash'],
  });

const fragmentStatus = z.strictObject({
  kind: z.literal('FRAGMENT_STATUS'),
  requestRef: OpaqueRefSchema,
  status: z.literal('DONE'),
  observedAt: IsoTimeSchema,
});

const manual = z.strictObject({
  kind: z.literal('MANUAL'),
  evidence: adminSingleLine(1000).regex(NO_CONTROL_CHARS),
});

export const AdminResolveProofSchema = z.discriminatedUnion('kind', [
  tonTx,
  tonNotSent,
  tonNotDebited,
  tonBounced,
  fragmentStatus,
  manual,
]);
export type AdminResolveProof = z.infer<typeof AdminResolveProofSchema>;

/** Phase 5 `proofNeedsOwnerOtp` for the panel's kinds: these always need the acting OWNER's code. */
export const ADMIN_RESOLVE_OTP_KINDS = ['TON_NOT_DEBITED', 'TON_BOUNCED', 'MANUAL'] as const;

/** True when carrying a proof of this kind needs the OWNER's code whatever the amount. */
export function resolveProofNeedsCode(kind: AdminResolveProof['kind']): boolean {
  return (ADMIN_RESOLVE_OTP_KINDS as readonly string[]).includes(kind);
}
