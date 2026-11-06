import { MAX_BIGINT_TIYIN, validationError } from '../../common/admin/admin-input';

// Wallet-only checks of the owner CLI; the common ones (reason, operator, ip, ids) live in
// common/admin/admin-input.ts, shared with the card services.

export function checkedAdjustAmount(amountTiyin: bigint): bigint {
  if (amountTiyin === 0n || amountTiyin > MAX_BIGINT_TIYIN || amountTiyin < -MAX_BIGINT_TIYIN) {
    throw validationError('amountTiyin');
  }
  return amountTiyin;
}

/**
 * Above the threshold the operator must retype the exact amount (the CLI asks for it): a typo in
 * a large number is caught before money moves. Equal to the threshold needs no confirmation.
 */
export function requireConfirmation(
  amountTiyin: bigint,
  confirmAmountTiyin: bigint | undefined,
  thresholdTiyin: bigint,
): void {
  const magnitude = amountTiyin < 0n ? -amountTiyin : amountTiyin;
  if (magnitude <= thresholdTiyin) return;
  if (confirmAmountTiyin !== amountTiyin) throw validationError('confirmAmountTiyin');
}
