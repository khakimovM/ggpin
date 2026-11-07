import { BANK_FEED_DEFAULTS, type BankDirection, type ChainStatus } from '@repo/shared';

// Pure rules of the matcher (docs/05 §6). No I/O: the service feeds them rows it read under the
// card lock and acts on the verdict.

/** The balance fields of a PARSED message, as stored on `BankMessage`. */
export interface ChainLink {
  readonly direction: BankDirection;
  readonly amountTiyin: bigint;
  readonly balanceAfterTiyin: bigint;
}

/**
 * The balance chain of one card (docs/05 §6 step 4): the previous PARSED message's balance plus
 * a CREDIT (minus a DEBIT) must give this message's balance. The first message of a card is
 * FIRST. Anything else is a BREAK: a missed, forged or reordered message (fail-closed, D-37 (8)).
 */
export function chainVerdict(
  previous: { readonly balanceAfterTiyin: bigint } | null,
  message: ChainLink,
): Exclude<ChainStatus, 'NOT_APPLICABLE'> {
  if (previous === null) return 'FIRST';
  const delta = message.direction === 'CREDIT' ? message.amountTiyin : -message.amountTiyin;
  return previous.balanceAfterTiyin + delta === message.balanceAfterTiyin ? 'OK' : 'BREAK';
}

/** The bank's printed time and Telegram's message date disagree by more than the allowed skew. */
export function isTimeSkewed(bankTxnAt: Date, tgDate: Date, skewSec: number): boolean {
  return Math.abs(bankTxnAt.getTime() - tgDate.getTime()) > skewSec * 1000;
}

/**
 * Earliest `createdAt` an intent may have to match a message sent at `tgDate`: an intent
 * created after the money arrived cannot be what it paid for, beyond a small clock leeway.
 */
export function latestMatchableCreatedAt(tgDate: Date): Date {
  return new Date(tgDate.getTime() + BANK_FEED_DEFAULTS.INTENT_CLOCK_LEEWAY_SEC * 1000);
}

/** The money came at or after the request's deadline: the user hears "late payment credited". */
export function isLatePayment(intent: { readonly expiresAt: Date }, paidAt: Date): boolean {
  return paidAt.getTime() >= intent.expiresAt.getTime();
}

/**
 * The money came after the request had stopped holding card capacity (D-42 (1)): its share may
 * already have been handed out again, so this payment can push the card over its limit.
 */
export function isPastCapacityHold(
  intent: { readonly expiresAt: Date },
  paidAt: Date,
  holdSec: number,
): boolean {
  return paidAt.getTime() > intent.expiresAt.getTime() + holdSec * 1000;
}

export interface CandidateIntent {
  readonly id: string;
  readonly status: 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED';
}

export type CandidateVerdict =
  | { readonly kind: 'CREDIT'; readonly intentId: string }
  | { readonly kind: 'CANCELLED_LATE'; readonly intentId: string }
  | { readonly kind: 'AMBIGUOUS' }
  | { readonly kind: 'NONE' };

/**
 * docs/05 §6 step 6 table. Candidates are the card's UNPAID intents for exactly this amount whose
 * reservation covers the message time. One PENDING or EXPIRED is credited, one CANCELLED goes to
 * review (the user said they would not pay, D-37 (5)), several is AMBIGUOUS (the EXCLUDE
 * constraint should make it impossible), none is looked into further (DUPLICATE / NO_MATCH).
 */
export function classifyCandidates(candidates: readonly CandidateIntent[]): CandidateVerdict {
  if (candidates.length > 1) return { kind: 'AMBIGUOUS' };
  const only = candidates[0];
  if (only === undefined) return { kind: 'NONE' };
  if (only.status === 'CANCELLED') return { kind: 'CANCELLED_LATE', intentId: only.id };
  if (only.status === 'PENDING' || only.status === 'EXPIRED') {
    return { kind: 'CREDIT', intentId: only.id };
  }
  return { kind: 'NONE' };
}
