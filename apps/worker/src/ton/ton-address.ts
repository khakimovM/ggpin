import { RAW_TON_ADDRESS_PATTERN, TON_HASH_PATTERN } from '@repo/shared';
import { Address } from '@ton/core';

// The worker converts every TON identifier at the edge into the ONE stored spelling (audit M2,
// N6): raw `<workchain>:<64 lowercase hex>` for accounts, 64 lowercase hex for hashes. The
// patterns are the ones the TonTransfer CHECK constraints use (@repo/shared).

/** An address that cannot be used. The message never repeats the input. */
export class TonAddressError extends Error {
  constructor(what: string, rule = 'a TON address of workchain 0 or -1') {
    super(`${what} is not ${rule}`);
    this.name = 'TonAddressError';
  }
}

/** Parses the raw or the user-friendly form; `what` names the value in the error. */
export function parseTonAddress(text: string, what: string): Address {
  let address: Address;
  try {
    address = Address.parse(text);
  } catch {
    throw new TonAddressError(what);
  }
  if (!RAW_TON_ADDRESS_PATTERN.test(rawAddress(address))) throw new TonAddressError(what);
  return address;
}

/**
 * Where an ORDER payout may go: workchain 0 only (Fragment's contracts live there; a masterchain
 * destination costs more and is never a payee of ours; audit L1, I1).
 */
export function parseOrderPayoutAddress(text: string, what: string): Address {
  const address = parseTonAddress(text, what);
  if (address.workChain !== 0) throw new TonAddressError(what, 'a TON address of workchain 0');
  return address;
}

/** The stored spelling of an account. */
export function rawAddress(address: Address): string {
  return address.toRawString().toLowerCase();
}

/** The stored spelling of a 32-byte hash. */
export function hashHex(hash: Buffer): string {
  const hex = hash.toString('hex');
  if (!TON_HASH_PATTERN.test(hex)) throw new Error('a TON hash has 32 bytes');
  return hex;
}
