import { randomInt } from 'node:crypto';
import { REFERRAL_CODE_LENGTH } from '@repo/shared';

// Must stay inside parseStartPayload's `ref_[a-z0-9]{8}` shape, or a code we hand out would
// not survive the /start deep link (referral-code.spec.ts proves the round trip).
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A fresh referral code. `randomInt(max)` draws uniformly (it rejects instead of taking a
 * modulo), so every character is unbiased. 36^8 is about 2.8e12; a collision is retried by the
 * caller against the `User.referralCode` unique index.
 */
export function generateReferralCode(): string {
  let code = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i += 1) {
    code += ALPHABET.charAt(randomInt(ALPHABET.length));
  }
  return code;
}
