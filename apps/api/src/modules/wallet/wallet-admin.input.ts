import { MAX_BIGINT_TIYIN, validationError } from '../../common/admin/admin-input';

// Wallet-only checks of the owner CLI; the common ones (reason, operator, ip, ids) live in
// common/admin/admin-input.ts, shared with the card services.

export function checkedAdjustAmount(amountTiyin: bigint): bigint {
  if (amountTiyin === 0n || amountTiyin > MAX_BIGINT_TIYIN || amountTiyin < -MAX_BIGINT_TIYIN) {
    throw validationError('amountTiyin');
  }
  return amountTiyin;
}

/** What the owner's code for wallet:adjust is bound to (ids only; the key makes it one command). */
export function adjustOtpTarget(userId: string, auditId: string | undefined): string {
  return `user ${userId} key ${auditId ?? '-'}`;
}

export function reverseOtpTarget(paymentId: string): string {
  return `payment ${paymentId}`;
}
