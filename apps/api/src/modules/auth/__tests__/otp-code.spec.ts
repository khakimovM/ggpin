import { createHash } from 'node:crypto';
import { LOGIN_NONCE_PATTERN, OTP_LENGTH } from '@repo/shared';
import { generateNonce, generateOtpCode, hashOtpCode, otpCodeMatches } from '../otp-code';

// Built at runtime: no secret-shaped literal in the source.
const PEPPER = ['test-pepper-', 'q'.repeat(24)].join('');
const OTHER_PEPPER = ['test-pepper-', 'r'.repeat(24)].join('');

describe('otp-code', () => {
  it('generates a zero-padded numeric code of OTP_LENGTH digits', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(generateOtpCode()).toMatch(new RegExp(`^\\d{${String(OTP_LENGTH)}}$`));
    }
  });

  it('pads small values: codes with leading zeros occur and keep their length', () => {
    // 10^6 space: P(no code < 100000 in 400 draws) = 0.9^400, i.e. never in practice.
    const codes = Array.from({ length: 400 }, generateOtpCode);
    expect(codes.some((code) => code.startsWith('0'))).toBe(true);
    expect(codes.every((code) => code.length === OTP_LENGTH)).toBe(true);
  });

  it('generates 43-character nonces that match the contract pattern and do not repeat', () => {
    const nonces = new Set(Array.from({ length: 200 }, generateNonce));
    expect(nonces.size).toBe(200);
    for (const nonce of nonces) expect(nonce).toMatch(LOGIN_NONCE_PATTERN);
  });

  describe('hashOtpCode', () => {
    const nonce = generateNonce();
    const code = '012345';

    it('is a hex HMAC, not the code and not an unpeppered sha256', () => {
      const hash = hashOtpCode(PEPPER, nonce, code);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).not.toContain(code);
      expect(hash).not.toBe(createHash('sha256').update(code).digest('hex'));
      expect(hash).not.toBe(createHash('sha256').update(`${nonce}:${code}`).digest('hex'));
    });

    it('is deterministic and depends on pepper, nonce and code', () => {
      const hash = hashOtpCode(PEPPER, nonce, code);
      expect(hashOtpCode(PEPPER, nonce, code)).toBe(hash);
      expect(hashOtpCode(OTHER_PEPPER, nonce, code)).not.toBe(hash);
      expect(hashOtpCode(PEPPER, generateNonce(), code)).not.toBe(hash);
      expect(hashOtpCode(PEPPER, nonce, '012346')).not.toBe(hash);
    });
  });

  describe('otpCodeMatches', () => {
    const nonce = generateNonce();
    const stored = hashOtpCode(PEPPER, nonce, '424242');

    it('accepts the right code and rejects every other', () => {
      expect(otpCodeMatches(PEPPER, nonce, '424242', stored)).toBe(true);
      expect(otpCodeMatches(PEPPER, nonce, '424243', stored)).toBe(false);
      expect(otpCodeMatches(PEPPER, nonce, '', stored)).toBe(false);
    });

    it('rejects the right code under another nonce or pepper', () => {
      expect(otpCodeMatches(PEPPER, generateNonce(), '424242', stored)).toBe(false);
      expect(otpCodeMatches(OTHER_PEPPER, nonce, '424242', stored)).toBe(false);
    });

    it('treats a malformed or short stored hash as no match instead of throwing', () => {
      expect(otpCodeMatches(PEPPER, nonce, '424242', '')).toBe(false);
      expect(otpCodeMatches(PEPPER, nonce, '424242', 'abcd')).toBe(false);
      expect(otpCodeMatches(PEPPER, nonce, '424242', 'zz'.repeat(32))).toBe(false);
    });
  });
});
