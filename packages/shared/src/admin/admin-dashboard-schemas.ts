// `GET /api/v1/admin/dashboard` (docs/04 "Admin" — dashboard; docs/09 §1). Days are Asia/Tashkent
// calendar days (`YYYY-MM-DD`), like the reconcile report.
import { z } from 'zod';
import { ResourceIdSchema } from '../common-schemas';
import { SignedTiyinStringSchema, TiyinStringSchema } from '../money-schemas';
import { CardBankSchema } from '../payments/bank-feed';
import { RANGE_ORDER_ISSUE, IsoDateTimeSchema, isOrderedRange } from './admin-common-schemas';

export const DASHBOARD_PERIODS = ['today', 'week', 'month', 'range'] as const;

/** `range` needs both `from` and `to` (at most 366 days apart); the other periods take neither. */
export const AdminDashboardQuerySchema = z
  .strictObject({
    period: z.enum(DASHBOARD_PERIODS).default('today'),
    from: IsoDateTimeSchema.optional(),
    to: IsoDateTimeSchema.optional(),
  })
  .refine(isOrderedRange, RANGE_ORDER_ISSUE)
  .refine(
    (q) =>
      q.period === 'range'
        ? q.from !== undefined &&
          q.to !== undefined &&
          Date.parse(q.to) - Date.parse(q.from) <= 366 * 86_400_000
        : q.from === undefined && q.to === undefined,
    { message: 'from/to only with period=range (at most 366 days)', path: ['period'] },
  );
export type AdminDashboardQuery = z.infer<typeof AdminDashboardQuerySchema>;

const CountSchema = z.number().int().min(0);
const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const DASHBOARD_ALERT_KINDS = [
  'ORDERS_NEEDS_REVIEW',
  'ORDERS_HELD',
  'PAYMENT_REVIEWS_OPEN',
  'FRAGMENT_SESSION_DEAD',
  'TON_BALANCE_LOW',
  'TON_DAILY_LIMIT_HIGH',
  'QUEUE_FAILED_JOBS',
  'RECONCILE_MISMATCH',
  'BANK_FEED_SILENT',
] as const;

export const AdminDashboardResponseSchema = z.strictObject({
  period: z.strictObject({ from: IsoDateTimeSchema, to: IsoDateTimeSchema }),
  kpi: z.strictObject({
    /** Sum of `priceTiyin − discountTiyin` of orders delivered in the period, not refunded since. */
    revenueTiyin: TiyinStringSchema,
    ordersCount: CountSchema,
    deliveredCount: CountSchema,
    /** delivered / (delivered + failed + refunded + cancelled) in basis points; null if none. */
    deliveryRateBps: z.number().int().min(0).max(10_000).nullable(),
    avgDeliverySec: z.number().int().min(0).nullable(),
    /** Revenue minus the locked cost in so'm at the order's FX snapshot; may be negative. */
    grossProfitTiyin: SignedTiyinStringSchema,
    newUsersCount: CountSchema,
    topupsTiyin: TiyinStringSchema,
    topupsCount: CountSchema,
  }),
  charts: z.strictObject({
    revenue: z.array(
      z.strictObject({
        day: DaySchema,
        revenueTiyin: TiyinStringSchema,
        profitTiyin: SignedTiyinStringSchema,
      }),
    ),
    productShare: z.array(
      z.strictObject({
        productId: ResourceIdSchema,
        productName: z.string(),
        revenueTiyin: TiyinStringSchema,
        ordersCount: CountSchema,
      }),
    ),
    topupBankShare: z.array(
      z.strictObject({ bank: CardBankSchema, amountTiyin: TiyinStringSchema, count: CountSchema }),
    ),
  }),
  /** Only what needs attention now; an empty list is "all fine". */
  alerts: z.array(
    z.strictObject({
      kind: z.enum(DASHBOARD_ALERT_KINDS),
      severity: z.enum(['warning', 'critical']),
      count: CountSchema.nullable(),
      since: IsoDateTimeSchema.nullable(),
    }),
  ),
});
export type AdminDashboardResponse = z.infer<typeof AdminDashboardResponseSchema>;
