// The ONE spelling of TON identifiers that ggpin stores and compares (audit M2, N6). A TON account
// has three textual forms (raw, bounceable, non-bounceable) that all name the same wallet, so a
// fence or a binding keyed on text could be passed by re-spelling the address. Only the RAW form
// `<workchain>:<64 lowercase hex>` and lowercase hex hashes are stored; the worker converts at the
// edge. These patterns are mirrored by the CHECK constraints of `TonTransfer` (migration 10), and
// a database test compares the two so they cannot drift apart.
import { z } from 'zod';

/**
 * Workchains of a real account: 0 (basechain) and -1 (masterchain). Not `-?[0-9]{1,3}`: that
 * accepted `00`, `000` and `-0`, which are the same workchain spelled differently (audit N6).
 */
export const RAW_TON_ADDRESS_PATTERN = /^(0|-1):[0-9a-f]{64}$/;

/** A message, payload or transaction hash: 32 bytes as 64 lowercase hex characters. */
export const TON_HASH_PATTERN = /^[0-9a-f]{64}$/;

export const RawTonAddressSchema = z.string().regex(RAW_TON_ADDRESS_PATTERN);
export const TonHashSchema = z.string().regex(TON_HASH_PATTERN);
