import { z } from 'zod';

/**
 * Phase 9 S6 tunables of the admin panel's money path (D-63 (4), (5)); part of EnvSchema.
 * - ADMIN_OTP_DAILY_MAX: step-up codes one admin may be sent per Asia/Tashkent day.
 * - ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN: money created by hand per Asia/Tashkent day (positive
 *   adjustments and review credits, CLI and panel together; default 5 000 000 so'm). BigInt
 *   tiyin parsed from digits, like every money setting (CLAUDE.md §5.1).
 */
export const adminWriteEnvShape = {
  ADMIN_OTP_DAILY_MAX: z.coerce.number().int().min(1).max(1000).default(30),
  ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN: z
    .string()
    .regex(/^\d+$/, 'must be a non-negative integer written with digits only')
    .default('500000000')
    .transform((v) => BigInt(v)),
};
