import type { AdminActor, CheckedAuditActor } from '../../../common/admin/audit-actor';
import { lowersCardLimit, requireCardStepUp } from '../card-admin.step-up';
import { OPEN_DEADLINE } from '../../../common/admin/__tests__/admin-deadline.fixture';

// Owner decision 2026-11-18 (SA-S6-3): every card retire and every LOWERED limit asks the panel's
// code; raising a limit does not; the CLI is never asked.

const card = { receiveLimitTiyin: 1_000_000n, monthlyLimitTiyin: 500_000n };

describe('lowersCardLimit', () => {
  it.each([
    ['a smaller receive limit', { limitTiyin: 999_999n }, true],
    ['the same receive limit', { limitTiyin: 1_000_000n }, false],
    ['a larger receive limit', { limitTiyin: 2_000_000n }, false],
    ['a smaller monthly cap', { limitTiyin: 1_000_000n, monthlyLimitTiyin: 499_999n }, true],
    ['the same monthly cap', { limitTiyin: 1_000_000n, monthlyLimitTiyin: 500_000n }, false],
    ['a larger monthly cap', { limitTiyin: 1_000_000n, monthlyLimitTiyin: 600_000n }, false],
    ['the monthly cap removed', { limitTiyin: 1_000_000n, monthlyLimitTiyin: null }, false],
    ['larger receive, smaller monthly', { limitTiyin: 9n ** 9n, monthlyLimitTiyin: 1n }, true],
  ] as const)('%s -> %s', (_name, limits, lowers) => {
    expect(lowersCardLimit(card, limits)).toBe(lowers);
  });

  it('a monthly cap set where there was none is lowering', () => {
    const uncapped = { receiveLimitTiyin: 1_000_000n, monthlyLimitTiyin: null };
    expect(
      lowersCardLimit(uncapped, { limitTiyin: 1_000_000n, monthlyLimitTiyin: 9n ** 12n }),
    ).toBe(true);
    expect(lowersCardLimit(uncapped, { limitTiyin: 1_000_000n })).toBe(false);
  });
});

/** The error a call throws, or undefined. */
function refusal(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const OTP_REQUIRED = { details: { field: 'otp', reason: 'OTP_REQUIRED' } };

describe('requireCardStepUp', () => {
  const admin = (permission: AdminActor['permission']): AdminActor => ({
    kind: 'ADMIN',
    adminId: 'a1',
    sessionId: 's1',
    ip: null,
    permission,
    request: { auditId: `a${'0'.repeat(63)}`, requestHash: 'h'.repeat(64) },
    deadline: OPEN_DEADLINE,
  });
  const cli: CheckedAuditActor = { kind: 'CLI', operator: 'aziz', ip: null, osUser: null };

  it('a retire always asks the panel for the code and records whether it was given', () => {
    expect(refusal(() => requireCardStepUp(admin('cards.retire'), false, false))).toMatchObject(
      OTP_REQUIRED,
    );
    expect(requireCardStepUp(admin('cards.retire'), true, false)).toEqual({ otpVerified: true });
  });

  it('a limit asks only when it lowers one', () => {
    expect(requireCardStepUp(admin('cards.limit'), false, false)).toEqual({ otpVerified: false });
    expect(refusal(() => requireCardStepUp(admin('cards.limit'), false, true))).toMatchObject(
      OTP_REQUIRED,
    );
  });

  it('the CLI is never asked and its audit row gets no panel field', () => {
    expect(requireCardStepUp(cli, false, true)).toEqual({});
  });
});
