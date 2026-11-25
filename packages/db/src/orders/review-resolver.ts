import type { Tx } from '../ledger/ledger.js';
import { ReviewProofError } from './errors.js';

/**
 * Who vouches for the proof. A trusted parameter of the helper, never a field of the proof.
 *
 * There is NO `role` here (audit L3): a role the caller writes is a role the caller can lie about.
 * For `type: 'ADMIN'` the helper reads the `AdminUser` row itself, inside the transaction, and
 * requires an active OWNER; `type: 'CLI'` is the owner's own command line (the owner CLI of S10,
 * which has no `AdminUser` row, D-46) and counts as OWNER. Resolving NEEDS_REVIEW is always a
 * money-moving or outcome-deciding action, so no other role may do it (rules/60).
 */
export type ReviewResolver =
  | { readonly kind: 'reconciler' }
  | {
      readonly kind: 'operator';
      readonly type: 'ADMIN' | 'CLI';
      /** The AdminUser id, or the owner id of the CLI session. Never empty. */
      readonly id: string;
      readonly ip: string | null;
      /** The OS login of a CLI operator (D-46). */
      readonly osUser: string | null;
      /**
       * True when the amount-confirmation OTP of D-46 was checked (S10 does the checking). It must
       * be the boolean `true` where the proof needs it: `"yes"` or `1` do not count (audit L2).
       */
      readonly otpVerified: boolean;
    };

/** An operator whose right to resolve was verified here: the role is the database's, not the caller's. */
export interface VerifiedOperator {
  readonly type: 'ADMIN' | 'CLI';
  readonly id: string;
  readonly role: 'OWNER';
  readonly ip: string | null;
  readonly osUser: string | null;
  readonly otpVerified: boolean;
}

/** `null` is the reconciler. */
export type VerifiedResolver = VerifiedOperator | null;

const isNullableText = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

/**
 * Validates the resolver with `typeof` (JS callers and job payloads are not type-checked: audit L2)
 * and, for an ADMIN, re-reads the `AdminUser` row inside the transaction: it must exist, be
 * active and be an OWNER (audit L3). Throws `ReviewProofError` (OPERATOR_REQUIRED for a malformed
 * resolver, OWNER_REQUIRED for an ADMIN that is not an active OWNER). For an ADMIN it reads the row
 * FOR SHARE (the first lock of the payout path, see below); a reconciler or CLI takes no lock.
 */
export async function verifyResolver(
  tx: Tx,
  resolver: unknown,
  orderId: string,
): Promise<VerifiedResolver> {
  const malformed = () => new ReviewProofError('OPERATOR_REQUIRED', orderId);
  if (typeof resolver !== 'object' || resolver === null) throw malformed();
  const candidate = resolver as Record<string, unknown>;
  if (candidate['kind'] === 'reconciler') return null;
  if (candidate['kind'] !== 'operator') throw malformed();
  const { type, id, ip, osUser, otpVerified } = candidate;
  if (
    (type !== 'ADMIN' && type !== 'CLI') ||
    typeof id !== 'string' ||
    id.trim() === '' ||
    !isNullableText(ip) ||
    !isNullableText(osUser) ||
    typeof otpVerified !== 'boolean'
  ) {
    throw malformed();
  }
  if (type === 'ADMIN') {
    // FOR SHARE (not FOR KEY SHARE): a concurrent demotion or deactivation of the admin waits for
    // this resolution to commit, and a demotion committed first is seen here (audit N3). Lock order of
    // the whole payout path: AdminUser -> wallet -> order -> attempt -> transfer; this is the first
    // lock of `resolveNeedsReview`, so it cannot deadlock with the helpers that follow.
    const rows = await tx.$queryRaw<{ role: string; isActive: boolean }[]>`
      SELECT "role"::text AS "role", "isActive" FROM "AdminUser" WHERE "id" = ${id} FOR SHARE`;
    const admin = rows[0];
    if (admin === undefined || !admin.isActive || admin.role !== 'OWNER') {
      throw new ReviewProofError('OWNER_REQUIRED', orderId);
    }
  }
  return { type, id, role: 'OWNER', ip, osUser, otpVerified };
}
