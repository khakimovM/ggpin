// `/api/v1/admin/infra/*` (docs/04 "Admin" — infra; docs/09 §7; plan S11, D-63 (8)). Read for
// OWNER and OPERATOR. Status only: never the mnemonic, keys, Fragment cookies, the bank-feed
// session or a supplier key (CLAUDE.md invariant 7). DRAFT until 9-B: the wallet, transfer and
// Fragment session rows are phase 5's.
import { z } from 'zod';
import { ResourceIdSchema } from '../common-schemas';
import { QUEUES } from '../queues';
import {
  AdminReasonSchema,
  IsoDateTimeSchema,
  MinorUnitsStringSchema,
} from './admin-common-schemas';
import { ROUTE_HEALTH_STATES } from './admin-catalog-schemas';
import { ADMIN_TON_TRANSFER_STATUSES } from './admin-orders-schemas';

const CountSchema = z.number().int().min(0);

/**
 * The hot wallet. `used24hNanoTon` counts every transfer of the rolling 24 h that may have left the
 * wallet, EXPIRED included (D-60 (2)); the limits are the worker's env, shown read-only.
 */
export const AdminInfraWalletResponseSchema = z.strictObject({
  network: z.enum(['mainnet', 'testnet']),
  address: z.string(),
  balance: z
    .strictObject({
      nanoTon: MinorUnitsStringSchema,
      microUsdt: MinorUnitsStringSchema,
      snapshotAt: IsoDateTimeSchema,
    })
    .nullable(),
  used24hNanoTon: MinorUnitsStringSchema,
  limits: z.strictObject({
    perOrderMaxNanoTon: MinorUnitsStringSchema,
    dailyMaxNanoTon: MinorUnitsStringSchema,
    minBalanceAlertNanoTon: MinorUnitsStringSchema,
  }),
  recentTransfers: z.array(
    z.strictObject({
      id: ResourceIdSchema,
      orderId: ResourceIdSchema.nullable(),
      status: z.enum(ADMIN_TON_TRANSFER_STATUSES),
      amountNanoTon: MinorUnitsStringSchema,
      txHash: z.string().nullable(),
      explorerUrl: z.string().nullable(),
      createdAt: IsoDateTimeSchema,
    }),
  ),
});
export type AdminInfraWalletResponse = z.infer<typeof AdminInfraWalletResponseSchema>;

/**
 * The Fragment session (state only). Renewing it is the owner CLI's `fragment:session-import`;
 * the panel shows that runbook, the semi-automatic re-login is out of phase 9 (D-63 (8)).
 */
export const AdminInfraFragmentResponseSchema = z.strictObject({
  status: z.enum(['ACTIVE', 'DEAD', 'NONE']),
  lastOkAt: IsoDateTimeSchema.nullable(),
  deadAt: IsoDateTimeSchema.nullable(),
  updatedAt: IsoDateTimeSchema.nullable(),
});
export type AdminInfraFragmentResponse = z.infer<typeof AdminInfraFragmentResponseSchema>;

export const AdminInfraAdaptersResponseSchema = z.array(
  z.strictObject({
    adapter: z.string(),
    health: z.enum(ROUTE_HEALTH_STATES),
    checkedAt: IsoDateTimeSchema.nullable(),
  }),
);
export type AdminInfraAdaptersResponse = z.infer<typeof AdminInfraAdaptersResponseSchema>;

export const AdminInfraQueuesResponseSchema = z.array(
  z.strictObject({
    name: z.string(),
    waiting: CountSchema,
    active: CountSchema,
    delayed: CountSchema,
    failed: CountSchema,
    paused: z.boolean(),
    /** Only `notify` and `tg-outbox` failed jobs may be retried from the panel (D-63 (8)). */
    retryable: z.boolean(),
  }),
);
export type AdminInfraQueuesResponse = z.infer<typeof AdminInfraQueuesResponseSchema>;

/** Queues whose failed jobs the OWNER may retry. Never fulfill-order, validate-recipient, bank-message. */
export const ADMIN_RETRYABLE_QUEUES = [QUEUES.NOTIFY, QUEUES.TG_OUTBOX] as const;

export const AdminQueueRetryParamsSchema = z.strictObject({
  name: z.enum(ADMIN_RETRYABLE_QUEUES),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});
export type AdminQueueRetryParams = z.infer<typeof AdminQueueRetryParamsSchema>;

/** A retry re-sends a message to a customer, so it says why (review CR-L4). */
export const AdminQueueRetryBodySchema = z.strictObject({ reason: AdminReasonSchema });
export type AdminQueueRetryBody = z.infer<typeof AdminQueueRetryBodySchema>;

export const AdminQueueRetryResponseSchema = z.strictObject({
  queue: z.enum(ADMIN_RETRYABLE_QUEUES),
  jobId: z.string(),
  auditId: ResourceIdSchema,
  applied: z.boolean(),
});
export type AdminQueueRetryResponse = z.infer<typeof AdminQueueRetryResponseSchema>;
