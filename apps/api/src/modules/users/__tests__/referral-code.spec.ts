import { parseStartPayload, REFERRAL_CODE_LENGTH } from '@repo/shared';
import { generateReferralCode } from '../referral-code';

describe('generateReferralCode', () => {
  it('is REFERRAL_CODE_LENGTH chars of [a-z0-9]', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(generateReferralCode()).toMatch(new RegExp(`^[a-z0-9]{${REFERRAL_CODE_LENGTH}}$`));
    }
  });

  it('is accepted by parseStartPayload as a ref_ deep link', () => {
    for (let i = 0; i < 500; i += 1) {
      const code = generateReferralCode();
      expect(parseStartPayload(`ref_${code}`)).toEqual({ kind: 'ref', code });
    }
  });

  it('does not repeat across a large sample and uses the whole alphabet', () => {
    const seen = new Set<string>();
    const chars = new Set<string>();
    for (let i = 0; i < 2_000; i += 1) {
      const code = generateReferralCode();
      seen.add(code);
      for (const ch of code) chars.add(ch);
    }
    expect(seen.size).toBe(2_000);
    expect(chars.size).toBe(36);
  });
});
