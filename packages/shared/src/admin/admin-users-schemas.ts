// `/api/v1/admin/users/*` (docs/04 "Admin" — users; docs/09 §3; plan S4, S6). The admin sees every
// user; the user-facing routes keep their owner scoping unchanged.
import { z } from 'zod';
import { localeSchema } from '../auth/auth-schemas';
import { ResourceIdSchema } from '../common-schemas';
import { SignedTiyinStringSchema, TiyinStringSchema } from '../money-schemas';
import type { OrderStatus } from '../order-state';
import { LEDGER_REF_TYPES, LedgerKindSchema } from '../wallet/ledger-schemas';
import {
  AdminNoteSchema,
  AdminReasonSchema,
  AdminSearchSchema,
  IsoDateTimeSchema,
  AdminAdjustAmountSchema,
  RANGE_ORDER_ISSUE,
  TelegramIdStringSchema,
  adminActionResultShape,
  adminDateRangeShape,
  adminPageQueryShape,
  adminSignedConfirmationShape,
  adminStateResultShape,
  isOrderedRange,
} from './admin-common-schemas';

const CountSchema = z.number().int().min(0);

export const ADMIN_USER_STATUS_FILTERS = ['ACTIVE', 'BLOCKED', 'FROZEN', 'BOT_BLOCKED'] as const;

/** `q`: `@username`, a Telegram id, or a user id. `from`/`to` filter `createdAt`. */
export const AdminUserListQuerySchema = z
  .strictObject({
    ...adminPageQueryShape,
    ...adminDateRangeShape,
    q: AdminSearchSchema.optional(),
    status: z.enum(ADMIN_USER_STATUS_FILTERS).optional(),
  })
  .refine(isOrderedRange, RANGE_ORDER_ISSUE);
export type AdminUserListQuery = z.infer<typeof AdminUserListQuerySchema>;

export const AdminUserRowSchema = z.strictObject({
  id: ResourceIdSchema,
  telegramId: TelegramIdStringSchema,
  username: z.string().nullable(),
  firstName: z.string().nullable(),
  locale: localeSchema,
  createdAt: IsoDateTimeSchema,
  lastSeenAt: IsoDateTimeSchema.nullable(),
  /** SUM(ledger); negative after a reversed top-up that was already spent. */
  balanceTiyin: SignedTiyinStringSchema,
  ordersCount: CountSchema,
  ordersTotalTiyin: TiyinStringSchema,
  referralsCount: CountSchema,
  isBlocked: z.boolean(),
  purchaseFrozen: z.boolean(),
  botBlocked: z.boolean(),
});
export type AdminUserRow = z.infer<typeof AdminUserRowSchema>;

export const AdminUserListResponseSchema = z.array(AdminUserRowSchema);
export type AdminUserListResponse = z.infer<typeof AdminUserListResponseSchema>;

/**
 * `GET /admin/users/:id`. `phone`: full for OWNER/OPERATOR, masked (`+998 ** *** ** 67`) for
 * SUPPORT (`users.phoneFull`); null when the user never shared one.
 */
export const AdminUserDetailResponseSchema = AdminUserRowSchema.extend({
  lastName: z.string().nullable(),
  photoUrl: z.string().nullable(),
  phone: z.string().max(32).nullable(),
  referralCode: z.string(),
  referredBy: z.strictObject({ id: ResourceIdSchema, username: z.string().nullable() }).nullable(),
  activeSessionsCount: CountSchema,
  /** The newest 20 notes; older ones are in the audit log (`USER_NOTE`). */
  notes: z.array(AdminNoteSchema),
});
export type AdminUserDetailResponse = z.infer<typeof AdminUserDetailResponseSchema>;

/** Paginated tabs of the user page share `?page=&limit=`. */
export const AdminUserTabQuerySchema = z.strictObject({ ...adminPageQueryShape });
export type AdminUserTabQuery = z.infer<typeof AdminUserTabQuerySchema>;

/** `GET /admin/users/:id/ledger` — unlike `/me/ledger`, the source (`refType`, `refId`) is shown. */
export const AdminUserLedgerResponseSchema = z.array(
  z.strictObject({
    id: ResourceIdSchema,
    kind: LedgerKindSchema,
    amountTiyin: SignedTiyinStringSchema,
    refType: z.enum(LEDGER_REF_TYPES),
    refId: z.string(),
    createdAt: IsoDateTimeSchema,
  }),
);
export type AdminUserLedgerResponse = z.infer<typeof AdminUserLedgerResponseSchema>;

export const AdminUserReferralsResponseSchema = z.array(
  z.strictObject({
    id: ResourceIdSchema,
    username: z.string().nullable(),
    createdAt: IsoDateTimeSchema,
  }),
);
export type AdminUserReferralsResponse = z.infer<typeof AdminUserReferralsResponseSchema>;

/** Web sessions of the user (Mini App tokens are stateless and not listed). */
export const AdminUserSessionsResponseSchema = z.array(
  z.strictObject({
    id: ResourceIdSchema,
    userAgent: z.string().nullable(),
    ipMasked: z.string().nullable(),
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    revokedAt: IsoDateTimeSchema.nullable(),
  }),
);
export type AdminUserSessionsResponse = z.infer<typeof AdminUserSessionsResponseSchema>;

/** block / unblock / freeze / unfreeze answer with the user's flags after the change. */
export const AdminUserStateResponseSchema = z.strictObject({
  userId: ResourceIdSchema,
  isBlocked: z.boolean(),
  purchaseFrozen: z.boolean(),
  /** Web sessions ended in the same transaction (block ends all of them, D-63 (9)). */
  revokedSessions: CountSchema,
  ...adminStateResultShape,
});
export type AdminUserStateResponse = z.infer<typeof AdminUserStateResponseSchema>;

export const AdminUserSessionsRevokeResponseSchema = z.strictObject({
  userId: ResourceIdSchema,
  revokedSessions: CountSchema,
  ...adminActionResultShape,
});
export type AdminUserSessionsRevokeResponse = z.infer<typeof AdminUserSessionsRevokeResponseSchema>;

/**
 * The 12-hex id of a set the owner saw before a positive adjustment (sha256 of the sorted ids):
 * the recent automatic top-ups (`confirmOverrideSet`, S9 F-L1) or the open orders
 * (`confirmOpenOrdersSet`, I-5). The server recomputes it under the wallet lock.
 */
export const AdminConfirmSetSchema = z.string().regex(/^[0-9a-f]{12}$/);

/**
 * Orders still in flight (I-5, owner decision 2026-11-22): a HELD or NEEDS_REVIEW order may yet
 * be refunded automatically, so a positive adjustment made as compensation must name them.
 */
export const ADMIN_OPEN_ORDER_STATUSES = Object.freeze([
  'PAID',
  'QUEUED',
  'PROCESSING',
  'HELD',
  'NEEDS_REVIEW',
] as const satisfies readonly OrderStatus[]);
export type AdminOpenOrderStatus = (typeof ADMIN_OPEN_ORDER_STATUSES)[number];

/**
 * `POST /admin/users/:id/adjust-wallet` (OWNER; `Idempotency-Key` required). `amountTiyin` is
 * signed: + credit, − debit. `confirmOverrideSet` is the 12-hex id of the recent automatic
 * top-ups the owner saw (the CLI's `--confirm-override=<set>`, S9 F-L1); `confirmOpenOrdersSet`
 * the id of the user's open orders (`--confirm-open-orders=<set>`, I-5). Both come from
 * `GET /admin/users/:id/adjust-preview`.
 */
export const AdminAdjustWalletBodySchema = z.strictObject({
  amountTiyin: AdminAdjustAmountSchema,
  reason: AdminReasonSchema,
  confirmOverrideSet: AdminConfirmSetSchema.optional(),
  confirmOpenOrdersSet: AdminConfirmSetSchema.optional(),
  ...adminSignedConfirmationShape,
});
export type AdminAdjustWalletBody = z.infer<typeof AdminAdjustWalletBodySchema>;

export const AdminAdjustWalletResponseSchema = z.strictObject({
  ledgerEntryId: ResourceIdSchema,
  balanceTiyin: SignedTiyinStringSchema,
  frozen: z.boolean(),
  ...adminActionResultShape,
});
export type AdminAdjustWalletResponse = z.infer<typeof AdminAdjustWalletResponseSchema>;

/** `GET /admin/users/:id/adjust-preview?amountTiyin=` (OWNER): signed, non-zero, within the max. */
export const AdminAdjustPreviewQuerySchema = z.strictObject({
  amountTiyin: AdminAdjustAmountSchema,
});
export type AdminAdjustPreviewQuery = z.infer<typeof AdminAdjustPreviewQuerySchema>;

/** Why the adjustment would ask for the code (the matrix rule of `users.adjustWallet`). */
export const ADMIN_ADJUST_OTP_REASONS = ['CREDIT', 'ABOVE_THRESHOLD', 'DAILY_BUDGET'] as const;
export type AdminAdjustOtpReason = (typeof ADMIN_ADJUST_OTP_REASONS)[number];

/**
 * What the adjustment would meet now, computed with the action's own functions (docs/04
 * «adjust-preview»): sending the two set ids back passes `RECENT_AUTO_TOPUP` / `OPEN_ORDERS`
 * unless a top-up or an order changed in between. Writes nothing.
 */
export const AdminAdjustPreviewResponseSchema = z.strictObject({
  balanceTiyin: SignedTiyinStringSchema,
  newBalanceTiyin: SignedTiyinStringSchema,
  otpRequired: z.boolean(),
  otpReason: z.enum(ADMIN_ADJUST_OTP_REASONS).nullable(),
  recentAutoTopups: z.array(
    z.strictObject({
      paymentId: ResourceIdSchema,
      amountTiyin: TiyinStringSchema,
      confirmedAt: IsoDateTimeSchema,
    }),
  ),
  confirmOverrideSet: AdminConfirmSetSchema.nullable(),
  openOrders: z.array(
    z.strictObject({
      id: ResourceIdSchema,
      number: z.number().int().min(1),
      status: z.enum(ADMIN_OPEN_ORDER_STATUSES),
      priceTiyin: TiyinStringSchema,
      createdAt: IsoDateTimeSchema,
    }),
  ),
  confirmOpenOrdersSet: AdminConfirmSetSchema.nullable(),
  manualCreditToday: z.strictObject({ usedTiyin: TiyinStringSchema, capTiyin: TiyinStringSchema }),
});
export type AdminAdjustPreview = z.infer<typeof AdminAdjustPreviewResponseSchema>;
