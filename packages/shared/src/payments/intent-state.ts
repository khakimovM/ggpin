// The ONLY source of allowed PaymentIntent.status transitions (docs/05-PAYMENTS.md "Model").
// A top-up intent is created PENDING and ends in exactly one of PAID / EXPIRED / CANCELLED, with
// two exceptions for money that arrives after the intent stopped waiting for it:
// - EXPIRED -> PAID automatically, but only while the unique amount is still reserved (the grace
//   window, D-37 (2)). Beyond it the amount may belong to another intent: crediting would be a
//   guess, so the payment goes to manual review instead;
// - CANCELLED -> PAID never automatically (D-37 (5)): the user told us they were not paying,
//   so money that still arrives is reviewed by the owner (`CANCELLED_LATE`).
// A human decision in the review queue (actor `admin`, audited) may settle a CANCELLED one, but
// ONLY inside the same grace window: after it no intent changes state, and money is credited
// through a review without an intent (a Payment with `reviewId`), which never extends
// `reservedUntil`.
import { z } from 'zod';

export const INTENT_STATUSES = ['PENDING', 'PAID', 'CANCELLED', 'EXPIRED'] as const;
export const IntentStatusSchema = z.enum(INTENT_STATUSES);
export type IntentStatus = z.infer<typeof IntentStatusSchema>;

export type IntentActor = 'system' | 'admin';

export interface IntentTransitionContext {
  /** True while the intent's unique amount is still reserved (`reservedUntil >= event time`). */
  readonly withinGrace: boolean;
  /** `system` = the worker/api code paths; `admin` = the owner CLI, with an audit row. */
  readonly actor: IntentActor;
}

export type IntentTransitionReason = 'NO_SUCH_TRANSITION' | 'GRACE_ELAPSED' | 'ACTOR_NOT_ALLOWED';

export class IntentTransitionError extends Error {
  constructor(
    readonly from: IntentStatus,
    readonly to: IntentStatus,
    readonly reason: IntentTransitionReason,
  ) {
    super(`Illegal intent transition ${from} -> ${to} (${reason})`);
    this.name = 'IntentTransitionError';
  }
}

// Frozen: a caller that could push a status into one of these lists would silently widen
// which intents may be credited.
const TRANSITIONS: Readonly<Record<IntentStatus, readonly IntentStatus[]>> = Object.freeze({
  PENDING: Object.freeze<IntentStatus[]>(['PAID', 'EXPIRED', 'CANCELLED']),
  EXPIRED: Object.freeze<IntentStatus[]>(['PAID']),
  CANCELLED: Object.freeze<IntentStatus[]>(['PAID']),
  PAID: Object.freeze<IntentStatus[]>([]),
});

/**
 * Whether the unique amount of an intent is still reserved at `at` (the bank message time for
 * a payment). `reservedUntil` is the stored column (`reservedUntilAtCreation` / `reservedUntilWhenPaid`).
 * The boundary is inclusive.
 */
export function isWithinGrace(at: Date, reservedUntil: Date): boolean {
  return at.getTime() <= reservedUntil.getTime();
}

/**
 * `PaymentIntent.reservedUntil` of a new intent (D-37 (2)): the request deadline plus the grace.
 * The grace is the gap this value fixes for the intent's whole life (see below).
 */
export function reservedUntilAtCreation(expiresAt: Date, graceSec: number): Date {
  return new Date(expiresAt.getTime() + graceSec * 1000);
}

/**
 * The ONLY `reservedUntil` the database accepts when an intent becomes PAID (trigger
 * `PaymentIntent_p2p_guard`, phase 4 S2): `GREATEST(reservedUntil, paidAt + grace)`, where
 * `grace = reservedUntil - expiresAt` is the gap set at creation. The trigger does not write the
 * value, it refuses any other. A reservation never shrinks (an amount still owed to the payer
 * must not be handed out again), and paying inside the original window keeps the old, longer end:
 * `paidAt + grace` alone would be SHORTER there and be refused.
 */
export function reservedUntilWhenPaid(
  intent: { readonly expiresAt: Date; readonly reservedUntil: Date },
  paidAt: Date,
): Date {
  const graceMs = intent.reservedUntil.getTime() - intent.expiresAt.getTime();
  return new Date(Math.max(intent.reservedUntil.getTime(), paidAt.getTime() + graceMs));
}

/** The refusal reason for a transition, or null when it is allowed. */
export function intentTransitionRefusal(
  from: IntentStatus,
  to: IntentStatus,
  ctx: IntentTransitionContext,
): IntentTransitionReason | null {
  if (!TRANSITIONS[from].includes(to)) return 'NO_SUCH_TRANSITION';
  if (to !== 'PAID' || from === 'PENDING') return null;
  if (from === 'CANCELLED' && ctx.actor !== 'admin') return 'ACTOR_NOT_ALLOWED';
  return ctx.withinGrace ? null : 'GRACE_ELAPSED';
}

export function canTransitionIntent(
  from: IntentStatus,
  to: IntentStatus,
  ctx: IntentTransitionContext,
): boolean {
  return intentTransitionRefusal(from, to, ctx) === null;
}

/** Throws `IntentTransitionError`; every intent status write goes through this. */
export function assertIntentTransition(
  from: IntentStatus,
  to: IntentStatus,
  ctx: IntentTransitionContext,
): void {
  const reason = intentTransitionRefusal(from, to, ctx);
  if (reason !== null) throw new IntentTransitionError(from, to, reason);
}
