// `/api/v1/admin/settings` and `/api/v1/admin/fx*` (docs/04 "Admin" — settings; docs/09 §5;
// D-63 (8): settings are read-only, the manual FX rate is the one write, OWNER). The manual FX
// write is phase 5's FxAdminService (`fx:set`, D-56 (3)); its shape is a DRAFT until 9-B.
import { z } from 'zod';
import { ResourceIdSchema } from '../common-schemas';
import type { FxPair } from '../money';
import {
  AdminOtpAnswerSchema,
  AdminReasonSchema,
  IsoDateTimeSchema,
  adminActionResultShape,
  adminPageQueryShape,
} from './admin-common-schemas';

/**
 * The values `GET /admin/settings` shows: the API's current env (and constants) that shape money
 * and limits. A whitelist: nothing secret can be added by accident. Worker-only values (TON
 * limits) are on `GET /admin/infra/wallet`.
 */
export const ADMIN_SETTING_KEYS = [
  'TOPUP_MIN_TIYIN',
  'TOPUP_MAX_TIYIN',
  'TOPUP_STEP_TIYIN',
  'TOPUP_DAILY_MAX_TIYIN',
  'TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN',
  'PRICE_TOLERANCE_BPS',
  'QUOTE_TTL_MS',
  'FX_MAX_AGE_MS',
  'FX_MAX_JUMP_BPS',
  'ADMIN_CONFIRM_THRESHOLD_TIYIN',
  'ADMIN_OPERATOR_REFUND_MAX_TIYIN',
  'ADMIN_OTP_DAILY_MAX',
  'ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN',
] as const;
export const SETTING_UNITS = ['TIYIN', 'BPS', 'MS', 'COUNT'] as const;

export const AdminSettingsResponseSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      key: z.enum(ADMIN_SETTING_KEYS),
      /** Decimal string (money and big numbers never travel as JSON numbers). */
      value: z.string().regex(/^-?\d{1,19}$/),
      unit: z.enum(SETTING_UNITS),
      source: z.enum(['env', 'constant']),
    }),
  ),
});
export type AdminSettingsResponse = z.infer<typeof AdminSettingsResponseSchema>;

/** Every stored `FxRate.pair` (money.ts FX_PAIRS; a test keeps the two equal). */
export const ADMIN_FX_PAIRS = [
  'USDT_UZS',
  'TON_USDT',
  'TON_UZS',
] as const satisfies readonly FxPair[];
// The FxRate_rate_check shape: no leading zeros, a bounded integer part, <= 18 decimals.
const RATE_PATTERN = /^(0|[1-9]\d{0,11})(\.\d{1,18})?$/;

export const AdminFxPairSchema = z.enum(ADMIN_FX_PAIRS);

/** Pairs the owner may set by hand; TON_UZS is derived from the two (phase 5 manual-fx.ts). */
export const ADMIN_MANUAL_FX_PAIRS = ['USDT_UZS', 'TON_USDT'] as const;

export const AdminFxHistoryQuerySchema = z.strictObject({
  ...adminPageQueryShape,
  pair: AdminFxPairSchema.optional(),
});
export type AdminFxHistoryQuery = z.infer<typeof AdminFxHistoryQuerySchema>;

export const AdminFxRateSchema = z.strictObject({
  id: ResourceIdSchema,
  pair: AdminFxPairSchema,
  /** Decimal string; all arithmetic is BigInt (money.ts). */
  rate: z.string().regex(RATE_PATTERN),
  source: z.string().max(128),
  createdAt: IsoDateTimeSchema,
});
export type AdminFxRate = z.infer<typeof AdminFxRateSchema>;

export const AdminFxHistoryResponseSchema = z.array(AdminFxRateSchema);
export type AdminFxHistoryResponse = z.infer<typeof AdminFxHistoryResponseSchema>;

/** A positive rate as the owner types it (phase 5 ManualFxRateSchema: <= 18 decimals, not 0). */
export const AdminManualFxRateSchema = z
  .string()
  .regex(RATE_PATTERN)
  .refine((rate) => !/^0(\.0+)?$/.test(rate), { message: 'rate must be positive' });

/**
 * `POST /admin/fx` (OWNER). When the jump rules flag the rate (D-56 (3): > 10 % against the
 * last 24 h), the rate is re-typed (`confirmRate`) and the code given — the CLI's `fx:set`.
 */
export const AdminFxSetBodySchema = z.strictObject({
  pair: z.enum(ADMIN_MANUAL_FX_PAIRS),
  rate: AdminManualFxRateSchema,
  reason: AdminReasonSchema,
  confirmRate: AdminManualFxRateSchema.optional(),
  otp: AdminOtpAnswerSchema.optional(),
});
export type AdminFxSetBody = z.infer<typeof AdminFxSetBodySchema>;

export const AdminFxSetResponseSchema = z.strictObject({
  fxRate: AdminFxRateSchema,
  /** The TON_UZS row derived in the same transaction; null when it could not be derived. */
  derived: AdminFxRateSchema.nullable(),
  ...adminActionResultShape,
});
export type AdminFxSetResponse = z.infer<typeof AdminFxSetResponseSchema>;
