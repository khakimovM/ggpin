import { otpBinding } from '../../../common/admin/owner-otp/owner-otp';
import { creditOtpFlags } from '../review-credit.checks';

// S8 R2: the owner's code for review:credit is bound to what the owner overrides and to
// --bank-verified, so a code issued for one decision never confirms another.

const CLEAN = { blocked: false, overLimit: false };
const NONE = { override: false, bankVerified: false };

describe('creditOtpFlags / otpBinding (S8 R2)', () => {
  it('names what the override overrides and the bank check; nothing given is empty', () => {
    expect(creditOtpFlags(CLEAN, NONE)).toBe('');
    expect(creditOtpFlags({ blocked: true, overLimit: true }, NONE)).toBe('');
    expect(creditOtpFlags({ blocked: true, overLimit: true }, { ...NONE, override: true })).toBe(
      'override: blocked, overLimit',
    );
    expect(creditOtpFlags({ blocked: false, overLimit: true }, { ...NONE, override: true })).toBe(
      'override: overLimit',
    );
    expect(creditOtpFlags(CLEAN, { override: true, bankVerified: true })).toBe(
      'override: none; bank-verified',
    );
    expect(creditOtpFlags(CLEAN, { ...NONE, bankVerified: true })).toBe('bank-verified');
  });

  it('the flags are part of the binding: another flag set is another binding', () => {
    const scope = {
      action: 'review:credit' as const,
      amountTiyin: 1n,
      target: 'review r for user u',
    };
    const bindings = ['', 'override: overLimit', 'bank-verified'].map((flags) =>
      otpBinding({ ...scope, flags }),
    );
    expect(new Set(bindings).size).toBe(3);
    expect(otpBinding(scope)).toBe(bindings[0]);
  });
});
