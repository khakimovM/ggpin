import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { OTP_LENGTH } from '@repo/shared';

// Pure helpers for the web login OTP. No I/O, so the security-relevant parts are unit-testable.

/** 43 URL-safe characters (256 bits); matches LOGIN_NONCE_PATTERN. */
export function generateNonce(): string {
  return randomBytes(32).toString('base64url');
}

/** A uniformly random, zero-padded numeric code ("004217"); randomInt avoids modulo bias. */
export function generateOtpCode(): string {
  return randomInt(0, 10 ** OTP_LENGTH)
    .toString()
    .padStart(OTP_LENGTH, '0');
}

// HMAC(pepper, nonce:code): a leaked LoginRequest table cannot be brute-forced offline without
// the pepper (a bare SHA-256 of 10^6 codes falls in milliseconds), and binding the nonce means a
// hash is useless for any other login request.
export function hashOtpCode(pepper: string, nonce: string, code: string): string {
  return createHmac('sha256', pepper).update(`${nonce}:${code}`).digest('hex');
}

/** Constant-time check of a submitted code against the stored hash. */
export function otpCodeMatches(
  pepper: string,
  nonce: string,
  code: string,
  storedHash: string,
): boolean {
  const given = Buffer.from(hashOtpCode(pepper, nonce, code), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  // timingSafeEqual throws on a length mismatch; a malformed stored value is simply "no match".
  return given.length === stored.length && timingSafeEqual(given, stored);
}
