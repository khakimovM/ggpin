import { AppError } from '../../exceptions/app-error';
import type { AdminActor, CheckedAuditActor } from '../audit-actor';
import { requireStepUp, stepUpFlagList, verifyStepUp, type StepUpCheck } from '../step-up';
import { OPEN_DEADLINE } from './admin-deadline.fixture';

// One code rule for both actors (D-46 CLI, D-63 (4) / D-65 panel): what each one needs; a wrong
// re-typed amount is AMOUNT_MISMATCH for both (D-65 (5), C-7).
const THRESHOLD = 100_000_000n;
const CLI: CheckedAuditActor = { kind: 'CLI', operator: 'aziz', ip: null, osUser: null };

function admin(permission: AdminActor['permission'], verify?: jest.Mock): AdminActor {
  return {
    kind: 'ADMIN',
    adminId: 'adm1',
    sessionId: 'ses1',
    ip: null,
    permission,
    request: { auditId: 'a1', requestHash: 'h' },
    deadline: OPEN_DEADLINE,
    ...(verify === undefined ? {} : { stepUp: { verify } }),
  };
}

function details(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? error.details : error;
  }
  return undefined;
}

const check = (owner: StepUpCheck['owner'], confirm?: bigint): StepUpCheck => ({
  owner,
  otp: undefined,
  confirmAmountTiyin: confirm,
  action: 'wallet:adjust',
  target: 'u1',
  flags: 'override: none',
  money: true,
});

describe('requireStepUp', () => {
  it('CLI: above the threshold only, with its own refusal shape (requireOwnerConfirmation)', () => {
    const at = { confirmAmountTiyin: undefined, verified: false, thresholdTiyin: THRESHOLD };
    expect(details(() => requireStepUp(CLI, { ...at, amountTiyin: THRESHOLD }))).toBeUndefined();
    expect(details(() => requireStepUp(CLI, { ...at, amountTiyin: THRESHOLD + 1n }))).toEqual({
      field: 'confirmAmountTiyin',
      reason: 'AMOUNT_MISMATCH',
    });
  });

  it('panel: a credit always needs the code; a small debit within the daily budget does not (D-65 D1)', () => {
    const actor = admin('users.adjustWallet');
    const need = { confirmAmountTiyin: 5n, verified: false, thresholdTiyin: THRESHOLD };
    expect(details(() => requireStepUp(actor, { ...need, amountTiyin: 5n }))).toEqual({
      field: 'otp',
      reason: 'OTP_REQUIRED',
    });
    const within = { ...need, amountTiyin: -5n, codelessBudgetExceeded: false };
    expect(details(() => requireStepUp(actor, within))).toBeUndefined();
    // Past the codeless budget, or the budget not read (fail closed): the code (SA-S6-3).
    const required = { field: 'otp', reason: 'OTP_REQUIRED' };
    expect(
      details(() => requireStepUp(actor, { ...within, codelessBudgetExceeded: true })),
    ).toEqual(required);
    expect(details(() => requireStepUp(actor, { ...need, amountTiyin: -5n }))).toEqual(required);
    expect(
      details(() => requireStepUp(actor, { ...need, amountTiyin: 5n, verified: true })),
    ).toBeUndefined();
  });

  it('panel: no code yet is OTP_REQUIRED even without the re-typed amount', () => {
    const actor = admin('payments.reverse');
    expect(
      details(() =>
        requireStepUp(actor, {
          amountTiyin: THRESHOLD + 1n,
          confirmAmountTiyin: undefined,
          verified: false,
          thresholdTiyin: THRESHOLD,
        }),
      ),
    ).toEqual({ field: 'otp', reason: 'OTP_REQUIRED' });
  });

  it('panel: the re-typed amount must be the real one (AMOUNT_MISMATCH)', () => {
    const actor = admin('payments.reviewCredit');
    expect(
      details(() =>
        requireStepUp(actor, {
          amountTiyin: 7n,
          confirmAmountTiyin: 8n,
          verified: true,
          thresholdTiyin: THRESHOLD,
        }),
      ),
    ).toEqual({ field: 'confirmAmountTiyin', reason: 'AMOUNT_MISMATCH' });
  });

  it('panel: card resume asks only when the rule says so (SECURITY pause, D-65 D3)', () => {
    const actor = admin('cards.resume');
    const base = { confirmAmountTiyin: undefined, verified: false, thresholdTiyin: 0n };
    expect(details(() => requireStepUp(actor, { ...base, ruleRequiresCode: false }))).toBe(
      undefined,
    );
    expect(details(() => requireStepUp(actor, { ...base, ruleRequiresCode: true }))).toEqual({
      field: 'otp',
      reason: 'OTP_REQUIRED',
    });
  });
});

describe('verifyStepUp', () => {
  it('CLI: the owner verifier with the CLI flags string', async () => {
    const owner = { verifyIfGiven: jest.fn().mockResolvedValue(false) };
    await expect(verifyStepUp(CLI, check(owner, 1n))).resolves.toBe(false);
    expect(owner.verifyIfGiven).toHaveBeenCalledWith(
      undefined,
      1n,
      'wallet:adjust',
      'u1',
      'override: none',
    );
  });

  it('panel: no code -> false; a code -> verified with the server flags as a list', async () => {
    const owner = { verifyIfGiven: jest.fn() };
    await expect(verifyStepUp(admin('users.adjustWallet'), check(owner, 1n))).resolves.toBe(false);
    const verify = jest.fn().mockResolvedValue(undefined);
    await expect(verifyStepUp(admin('users.adjustWallet', verify), check(owner, 1n))).resolves.toBe(
      true,
    );
    expect(verify).toHaveBeenCalledWith(['override: none']);
    expect(owner.verifyIfGiven).not.toHaveBeenCalled();
  });

  it('panel: a code without the re-typed amount is AMOUNT_MISMATCH, the code not spent', async () => {
    const verify = jest.fn();
    const error: unknown = await verifyStepUp(
      admin('users.adjustWallet', verify),
      check({ verifyIfGiven: jest.fn() }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).details).toEqual({
      field: 'confirmAmountTiyin',
      reason: 'AMOUNT_MISMATCH',
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('no flags is an empty list', () => {
    expect(stepUpFlagList('')).toEqual([]);
    expect(stepUpFlagList('bank-verified')).toEqual(['bank-verified']);
  });
});
