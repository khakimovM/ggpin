import { randomBytes } from 'node:crypto';
import { Address } from '@ton/core';
import { parseAesKey, sealAesGcm } from '../../crypto/aes-gcm';
import { tonMnemonicPurpose } from '../../ton/ton-mnemonic';

/** An endpoint that can never resolve (RFC 2606 `.invalid`): nothing is ever sent to it. */
export const UNREACHABLE_TON_ENDPOINT = 'https://toncenter.invalid/api/v2/jsonRPC';

/** A recognisable marker assembled at run time, not a credential (the gateway sends it). */
export const TEST_TON_API_KEY = ['marker', 'for', 'env', 'tests'].join('-');

/**
 * The TON settings FULFILLMENT_DRY_RUN=false requires (plan §5, audit L5, review M2), made per
 * call for env-parsing tests: a random key, a blob that opens with it on testnet (the boot check
 * only proves that the key fits the blob; the plaintext is NOT a mnemonic, so no wallet can ever be
 * opened from it), an address nobody owns, an unreachable endpoint, a marker API key and explicit
 * limits. No real secret, nothing a scanner could match.
 */
export function tonLiveSource(): Readonly<Record<string, string>> {
  const key = randomBytes(32).toString('base64');
  const blob = sealAesGcm(
    Buffer.from('env parsing only, not a mnemonic', 'utf8'),
    parseAesKey(key),
    tonMnemonicPurpose('testnet'),
  );
  return {
    TON_API_ENDPOINT: UNREACHABLE_TON_ENDPOINT,
    TON_MNEMONIC_ENC: blob,
    WALLET_ENC_KEY: key,
    TON_WALLET_ADDRESS: new Address(0, randomBytes(32)).toRawString(),
    TON_API_KEY: TEST_TON_API_KEY,
    TON_MAX_PER_ORDER_NANO: '50000000000',
    TON_MAX_DAILY_NANO: '500000000000',
  };
}
