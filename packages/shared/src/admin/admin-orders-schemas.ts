// Read side of `/api/v1/admin/orders/*` (docs/04 "Admin" — orders; docs/09 §2; plan S10).
// DRAFT: the order, attempt and TON transfer shapes come from phase 5 (feat/p5-stars-order:
// order-admin.repository.ts, cli/order-view.ts, schema.prisma) and are checked against the merged
// code in 9-B. Never on the wire: `providerRef`, the idempotency key, request hashes, the signed
// BOC, an adapter's raw secrets (an attempt shows only `AdminAttemptFactsSchema`).
import { z } from 'zod';
import { ResourceIdSchema } from '../common-schemas';
import { SignedTiyinStringSchema, TiyinStringSchema } from '../money-schemas';
import { orderStatusSchema } from '../order-state';
import { LEDGER_REF_TYPES, LedgerKindSchema } from '../wallet/ledger-schemas';
import {
  AdminNoteSchema,
  AdminSearchSchema,
  IsoDateTimeSchema,
  MinorUnitsStringSchema,
  RANGE_ORDER_ISSUE,
  adminDateRangeShape,
  adminPageQueryShape,
  isOrderedRange,
} from './admin-common-schemas';

const CountSchema = z.number().int().min(0);
const AdapterCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/);
const DIGITS = /^\d{1,19}$/;

/** `?status=PAID,QUEUED` like the user route (docs/04 Q-C): one or more raw statuses. */
const StatusListSchema = z
  .string()
  .max(200)
  .transform((value) => value.split(','))
  .pipe(z.array(orderStatusSchema).min(1).max(9));

/** `q`: `#1042` (order number), `@username`, or a TON transaction hash. */
export const AdminOrderListQuerySchema = z
  .strictObject({
    ...adminPageQueryShape,
    ...adminDateRangeShape,
    status: StatusListSchema.optional(),
    productId: ResourceIdSchema.optional(),
    adapter: AdapterCodeSchema.optional(),
    userId: ResourceIdSchema.optional(),
    minTiyin: TiyinStringSchema.optional(),
    maxTiyin: TiyinStringSchema.optional(),
    q: AdminSearchSchema.optional(),
  })
  .refine(isOrderedRange, RANGE_ORDER_ISSUE)
  .refine(
    // Guarded: a refinement may run after a field already failed, and BigInt("1.5") throws.
    (q) =>
      q.minTiyin === undefined ||
      q.maxTiyin === undefined ||
      !DIGITS.test(q.minTiyin) ||
      !DIGITS.test(q.maxTiyin) ||
      BigInt(q.minTiyin) <= BigInt(q.maxTiyin),
    { message: 'minTiyin must not exceed maxTiyin', path: ['minTiyin'] },
  );
export type AdminOrderListQuery = z.infer<typeof AdminOrderListQuerySchema>;

export const AdminOrderRowSchema = z.strictObject({
  id: ResourceIdSchema,
  number: z.number().int().min(1),
  createdAt: IsoDateTimeSchema,
  user: z.strictObject({ id: ResourceIdSchema, username: z.string().nullable() }),
  product: z.strictObject({ id: ResourceIdSchema, slug: z.string(), name: z.string() }),
  sku: z.strictObject({ id: ResourceIdSchema, label: z.string() }).nullable(),
  quantity: z.number().int().min(1),
  recipient: z.strictObject({
    displayName: z.string().nullable(),
    fields: z.record(z.string(), z.string()),
  }),
  priceTiyin: TiyinStringSchema,
  discountTiyin: TiyinStringSchema,
  totalTiyin: TiyinStringSchema,
  /** The locked cost in its own currency (`USDT` micro, `TON` nano, ...). */
  costCurrency: z.string().max(8),
  costMinor: MinorUnitsStringSchema,
  /** total − cost in so'm at the order's FX snapshot; null until DELIVERED. May be negative. */
  profitTiyin: SignedTiyinStringSchema.nullable(),
  status: orderStatusSchema,
  statusReason: z.string().max(64).nullable(),
  /** The adapter of the latest attempt; null before the first one. */
  adapter: AdapterCodeSchema.nullable(),
  deliveredAt: IsoDateTimeSchema.nullable(),
});
export type AdminOrderRow = z.infer<typeof AdminOrderRowSchema>;

export const AdminOrderListResponseSchema = z.array(AdminOrderRowSchema);
export type AdminOrderListResponse = z.infer<typeof AdminOrderListResponseSchema>;

export const ADMIN_ATTEMPT_STATUSES = [
  'SENDING',
  'SENT',
  'CONFIRMED',
  'FAILED',
  'UNKNOWN',
] as const;
export const ADMIN_TON_TRANSFER_STATUSES = [
  'SIGNED',
  'BROADCAST',
  'CONFIRMED',
  'ONCHAIN_FAILED',
  'EXPIRED',
  'CONSUMED_UNMATCHED',
  'BOUNCED',
] as const;

/** A TON transaction hash as the order page and the refund body carry it (lower-case hex). */
export const AdminTxHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const TxHashSchema = AdminTxHashSchema;
const LtSchema = z.string().regex(/^(0|[1-9]\d{0,19})$/);

/**
 * What the panel shows of an attempt's stored JSON: an allowlist PROJECTION built by the server
 * (review SA-M4), never the JSON itself. `request` is not shown at all (it holds the
 * `recheckedProviderRef` and the payload BOC); of `response` only the TON facts the worker
 * recorded (S5: payment target, bounce, the first expiry observation, a witness conflict).
 * DRAFT: the source paths (`response.ton.*`) are checked against phase 5 in 9-B.
 */
export const AdminAttemptFactsSchema = z.strictObject({
  ton: z
    .strictObject({
      toAddress: z.string().max(128).nullable(),
      amountNanoTon: MinorUnitsStringSchema.nullable(),
      bounce: z
        .strictObject({
          txHash: TxHashSchema,
          txLt: LtSchema,
          returnTxHash: TxHashSchema,
          returnLt: LtSchema,
          returnedNanoTon: MinorUnitsStringSchema,
        })
        .nullable(),
      expiry: z
        .strictObject({ seqno: z.number().int().min(0), observedAt: IsoDateTimeSchema })
        .nullable(),
      witnessConflict: z.boolean(),
    })
    .nullable(),
});
export type AdminAttemptFacts = z.infer<typeof AdminAttemptFactsSchema>;

export const AdminTonTransferSchema = z.strictObject({
  id: ResourceIdSchema,
  attemptId: ResourceIdSchema,
  status: z.enum(ADMIN_TON_TRANSFER_STATUSES),
  network: z.enum(['mainnet', 'testnet']),
  walletAddress: z.string(),
  toAddress: z.string(),
  amountNanoTon: MinorUnitsStringSchema,
  feeNanoTon: MinorUnitsStringSchema.nullable(),
  seqno: CountSchema,
  validUntil: IsoDateTimeSchema,
  extMsgHash: z.string(),
  txHash: z.string().nullable(),
  txLt: MinorUnitsStringSchema.nullable(),
  /** tonviewer link built by the server for the network; null without a transaction. */
  explorerUrl: z.string().nullable(),
  confirmedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});

export const AdminOrderDetailResponseSchema = AdminOrderRowSchema.extend({
  events: z.array(
    z.strictObject({
      from: orderStatusSchema.nullable(),
      to: orderStatusSchema,
      /** SYSTEM | RECONCILER | ADMIN | ADMIN:<id> (phase 5 transitionOrder). */
      actor: z.string(),
      note: z.string().nullable(),
      createdAt: IsoDateTimeSchema,
    }),
  ),
  attempts: z.array(
    z.strictObject({
      id: ResourceIdSchema,
      attemptNo: z.number().int().min(1),
      adapter: AdapterCodeSchema,
      status: z.enum(ADMIN_ATTEMPT_STATUSES),
      externalRef: z.string().nullable(),
      error: z.string().nullable(),
      facts: AdminAttemptFactsSchema,
      createdAt: IsoDateTimeSchema,
    }),
  ),
  tonTransfers: z.array(AdminTonTransferSchema),
  ledger: z.array(
    z.strictObject({
      id: ResourceIdSchema,
      kind: LedgerKindSchema,
      amountTiyin: SignedTiyinStringSchema,
      refType: z.enum(LEDGER_REF_TYPES),
      createdAt: IsoDateTimeSchema,
    }),
  ),
  /** Money already returned to the wallet for this order (full and partial refunds). */
  refundedTiyin: TiyinStringSchema,
  quote: z.strictObject({
    id: ResourceIdSchema,
    priceTiyin: TiyinStringSchema,
    costMinor: MinorUnitsStringSchema,
    maxCostMinor: MinorUnitsStringSchema,
    costCurrency: z.string().max(8),
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
  }),
  fxRate: z.strictObject({
    id: ResourceIdSchema,
    pair: z.string(),
    rate: z.string(),
    source: z.string(),
    createdAt: IsoDateTimeSchema,
  }),
  notes: z.array(AdminNoteSchema),
});
export type AdminOrderDetailResponse = z.infer<typeof AdminOrderDetailResponseSchema>;

/** `GET /admin/orders/review-queue`: NEEDS_REVIEW and HELD, oldest first. */
export const AdminReviewQueueQuerySchema = z.strictObject({
  ...adminPageQueryShape,
  status: z.enum(['NEEDS_REVIEW', 'HELD']).optional(),
});
export type AdminReviewQueueQuery = z.infer<typeof AdminReviewQueueQuerySchema>;

export const AdminReviewQueueResponseSchema = z.array(
  AdminOrderRowSchema.extend({
    /** When the order entered its current status (its last OrderEvent). */
    enteredAt: IsoDateTimeSchema,
    ageSec: CountSchema,
  }),
);
export type AdminReviewQueueResponse = z.infer<typeof AdminReviewQueueResponseSchema>;
