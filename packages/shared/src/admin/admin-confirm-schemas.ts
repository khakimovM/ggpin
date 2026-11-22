// `POST /api/v1/admin/confirmations` (docs/04 "Admin" — confirmations; D-63 (4)): issues the
// acting admin's one-time code for ONE action. The body names the action and EVERY value the code
// will be bound to: the server binds sha256 of the canonical JSON of the whole parsed body
// (`adminConfirmationCanonical`) plus `adminId` and `sessionId`, and the action recomputes the
// same body from its own request and compares (review SA-M2, CR-H2). Flags are never taken from
// the client: the server computes them under its locks (CLI rule).
import { z } from 'zod';
import { IdempotencyKeySchema, ResourceIdSchema } from '../common-schemas';
import { TiyinStringSchema } from '../money-schemas';
import {
  AdminNameSchema,
  AdminReasonSchema,
  AdminAdjustAmountSchema,
  PositiveTiyinStringSchema,
  TelegramIdStringSchema,
} from './admin-common-schemas';
import {
  ONE_CREDIT_TARGET_ISSUE,
  adminCreditTargetShape,
  isOneCreditTarget,
} from './admin-payments-schemas';
import { AdminTxHashSchema } from './admin-orders-schemas';
import { AdminResolveProofSchema } from './admin-resolve-proof-schemas';
import { PanelAssignableRoleSchema } from './admin-roles';
import { ADMIN_MANUAL_FX_PAIRS, AdminManualFxRateSchema } from './admin-settings-schemas';

const moneyAction = <A extends string>(action: A) =>
  z.strictObject({
    action: z.literal(action),
    targetId: ResourceIdSchema,
    /** The amount as the admin re-typed it; the action re-checks it against the real one. */
    amountTiyin: PositiveTiyinStringSchema,
  });

const targetOnly = <A extends string>(action: A) =>
  z.strictObject({ action: z.literal(action), targetId: ResourceIdSchema });

export const AdminConfirmationBodySchema = z.discriminatedUnion('action', [
  moneyAction('orders.cancel'),
  moneyAction('orders.failAndRefund'),
  z.strictObject({
    action: z.literal('orders.refund'),
    targetId: ResourceIdSchema,
    /** FULL: the re-typed remaining total; PARTIAL: the re-typed partial amount. */
    amountTiyin: PositiveTiyinStringSchema,
    mode: z.enum(['FULL', 'PARTIAL']),
    returnTxHash: AdminTxHashSchema.optional(),
  }),
  moneyAction('payments.reverse'),
  z.strictObject({
    action: z.literal('orders.resolve'),
    targetId: ResourceIdSchema,
    /** The order total (a FAILED exit refunds it). */
    amountTiyin: TiyinStringSchema,
    outcome: z.enum(['DELIVERED', 'FAILED']),
    proof: AdminResolveProofSchema,
    deliveredOutsideSystem: z.boolean().default(false),
    /** The proof's digest includes its reason (phase 5 `proofDigest`), so the code binds it too. */
    reason: AdminReasonSchema,
  }),
  z
    .strictObject({
      action: z.literal('payments.reviewCredit'),
      targetId: ResourceIdSchema,
      amountTiyin: PositiveTiyinStringSchema,
      ...adminCreditTargetShape,
      confirmOverride: z.boolean().default(false),
      bankVerified: z.boolean().default(false),
    })
    .refine(isOneCreditTarget, ONE_CREDIT_TARGET_ISSUE),
  z.strictObject({
    action: z.literal('users.adjustWallet'),
    targetId: ResourceIdSchema,
    amountTiyin: AdminAdjustAmountSchema,
    confirmOverrideSet: z
      .string()
      .regex(/^[0-9a-f]{12}$/)
      .optional(),
    /**
     * The owner CLI's adjust target contains the idempotency key (wallet-admin.input.ts); the
     * action's `Idempotency-Key` header must equal it, so one code moves money once.
     */
    idempotencyKey: IdempotencyKeySchema,
  }),
  z.strictObject({
    action: z.literal('cards.resume'),
    targetId: ResourceIdSchema,
    /** The CLI's `--confirm-override` / `--confirm-security-pause` (D-65 D3). */
    confirmOverride: z.boolean().default(false),
    confirmSecurityPause: z.boolean().default(false),
  }),
  // A retire always needs the code; a limit only when it lowers one (owner decision 2026-11-18).
  z.strictObject({
    action: z.literal('cards.retire'),
    targetId: ResourceIdSchema,
    emergency: z.boolean().default(false),
  }),
  z.strictObject({
    action: z.literal('cards.limit'),
    targetId: ResourceIdSchema,
    receiveLimitTiyin: PositiveTiyinStringSchema,
    monthlyLimitTiyin: PositiveTiyinStringSchema.nullable().optional(),
  }),
  z.strictObject({
    action: z.literal('fx.set'),
    /** Bound: the pair and the rate itself (a code for 12 650 does not set 99 999). */
    pair: z.enum(ADMIN_MANUAL_FX_PAIRS),
    rate: AdminManualFxRateSchema,
  }),
  z.strictObject({
    action: z.literal('admins.create'),
    telegramId: TelegramIdStringSchema,
    name: AdminNameSchema,
    role: PanelAssignableRoleSchema,
  }),
  z
    .strictObject({
      action: z.literal('admins.update'),
      targetId: ResourceIdSchema,
      name: AdminNameSchema.optional(),
      role: PanelAssignableRoleSchema.optional(),
      isActive: z.boolean().optional(),
    })
    .refine((b) => b.name !== undefined || b.role !== undefined || b.isActive !== undefined, {
      message: 'nothing to change',
      path: [],
    }),
  targetOnly('admins.sessionsRevoke'),
  targetOnly('sessions.revoke'),
]);
export type AdminConfirmationBody = z.infer<typeof AdminConfirmationBodySchema>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}

/**
 * The text the code is bound to: the PARSED body (defaults filled) as JSON with sorted keys and
 * absent fields dropped. The server hashes it (sha256) together with `adminId` and `sessionId`;
 * the action builds the same body from its own request, so any changed field breaks the match.
 */
export function adminConfirmationCanonical(body: AdminConfirmationBody): string {
  return JSON.stringify(canonical(body));
}

/**
 * `challengeId` (128 bits, hex) goes back to the browser (the HTTP form of D-46): on its own it is
 * worth nothing — the code from the admin's Telegram, the same session and the same binding are
 * needed. Valid `expiresInSec` (180, like every code), one use, 5 attempts.
 */
export const AdminConfirmationResponseSchema = z.strictObject({
  challengeId: z.string().regex(/^[0-9a-f]{32}$/),
  expiresInSec: z.number().int().min(1),
});
export type AdminConfirmationResponse = z.infer<typeof AdminConfirmationResponseSchema>;
