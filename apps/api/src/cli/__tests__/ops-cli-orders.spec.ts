import { OwnerOtpIssuer } from '../../common/admin/owner-otp/owner-otp.issuer';
import { FxAdminService } from '../../modules/fx-admin/fx-admin.service';
import { OrderReviewService } from '../../modules/orders/admin/order-review.service';
import { WHO, runFake as run } from './fake-cli';

// The order and FX commands without a database (phase 5 S10): what is asked, what reaches the
// services, and that the owner's code is bound to the right scope and never printed.

const CHALLENGE = 'c'.repeat(32);
const CODE = '481516';
const ORDER = 'ckorder0000000000000000001';
const MANUAL = JSON.stringify({ kind: 'MANUAL', evidence: 'receipt' });

const EFFECTS = { customerNotified: true, adminAction: true, reviewResolved: true };

function resolveServices(preview: Record<string, unknown>) {
  const issue = jest.fn().mockResolvedValue({ challengeId: CHALLENGE, expiresInSec: 180 });
  const discard = jest.fn().mockResolvedValue(undefined);
  const resolve = jest.fn().mockResolvedValue({
    applied: true,
    orderId: ORDER,
    to: 'FAILED',
    auditId: 'a1',
    refundTiyin: 550_000n,
    refundEntryId: 'e1',
    effects: { ...EFFECTS, securityAlert: null },
  });
  const previewFn = jest.fn().mockResolvedValue({
    orderId: ORDER,
    number: 7,
    status: 'NEEDS_REVIEW',
    totalTiyin: 550_000n,
    proof: { kind: 'MANUAL' },
    needsOtp: true,
    otpTarget: `order ${ORDER} FAILED MANUAL 0123456789ab`,
    otpFlags: '',
    outsideSystem: false,
    ...preview,
  });
  const services = new Map<unknown, unknown>([
    [OrderReviewService, { preview: previewFn, resolve }],
    [OwnerOtpIssuer, { issue, discard }],
  ]);
  return { issue, discard, resolve, preview: previewFn, services };
}

describe('order:resolve (no database)', () => {
  it('usage: exactly one of --delivered / --failed, a JSON proof; nothing reaches the service', async () => {
    const s = resolveServices({});
    for (const argv of [
      ['order:resolve', ORDER, '--proof', MANUAL, ...WHO],
      ['order:resolve', ORDER, '--failed', '--delivered', '--proof', MANUAL, ...WHO],
      ['order:resolve', ORDER, '--failed', ...WHO],
      ['order:resolve', ORDER, '--failed', '--proof', '{nope', ...WHO],
      ['order:resolve', '--failed', '--proof', MANUAL, ...WHO],
    ]) {
      expect((await run(argv, s.services)).code).toBe(2);
    }
    expect(s.preview).not.toHaveBeenCalled();
  });

  it('an owner proof: re-typed amount, then the code bound to the proof; discarded after; never printed', async () => {
    const s = resolveServices({});
    const out = await run(
      ['order:resolve', ORDER, '--failed', '--proof', MANUAL, ...WHO],
      s.services,
      ['5500', CODE],
    );
    expect(out.code).toBe(0);
    expect(out.asked).toHaveLength(2);
    expect(s.issue).toHaveBeenCalledWith({
      action: 'order:resolve',
      amountTiyin: 550_000n,
      target: `order ${ORDER} FAILED MANUAL 0123456789ab`,
    });
    expect(s.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'FAILED',
        reason: 'why',
        operator: 'aziz',
        confirmAmountTiyin: 550_000n,
        otp: { challengeId: CHALLENGE, code: CODE },
      }),
    );
    expect(s.discard).toHaveBeenCalledWith(CHALLENGE);
    const printed = [...out.out, ...out.err].join('\n');
    expect(printed).not.toContain(CODE);
    expect(printed).not.toContain(CHALLENGE);
  });

  it('a chain proof below the threshold asks nothing', async () => {
    const s = resolveServices({ needsOtp: false, proof: { kind: 'TON_NOT_SENT' } });
    const out = await run(
      ['order:resolve', ORDER, '--failed', '--proof', '{"kind":"TON_NOT_SENT"}', ...WHO],
      s.services,
    );
    expect(out.code).toBe(0);
    expect(out.asked).toEqual([]);
    expect(s.issue).not.toHaveBeenCalled();
  });

  it('I-8: warns and asks nothing without --delivered-outside-system; with it the code names the flag', async () => {
    const outside = { outsideSystem: true, otpFlags: 'delivered-outside-system' };
    const s = resolveServices(outside);
    const warned = await run(
      ['order:resolve', ORDER, '--delivered', '--proof', MANUAL, ...WHO],
      s.services,
    );
    expect(warned.asked).toEqual([]);
    expect(warned.err.join('\n')).toContain('outside the system');
    expect(s.resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirmOutsideSystem: false }),
    );

    const ok = await run(
      [
        'order:resolve',
        ORDER,
        '--delivered',
        '--proof',
        MANUAL,
        ...WHO,
        '--delivered-outside-system',
      ],
      s.services,
      ['5500', CODE],
    );
    expect(ok.code).toBe(0);
    expect(s.issue).toHaveBeenCalledWith(
      expect.objectContaining({ flags: 'delivered-outside-system' }),
    );
    expect(s.resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirmOutsideSystem: true }),
    );
  });

  it('re-review N4: --delivered-outside-system where it does not apply asks for no code', async () => {
    const s = resolveServices({ outsideSystem: false });
    const out = await run(
      [
        'order:resolve',
        ORDER,
        '--delivered',
        '--proof',
        MANUAL,
        ...WHO,
        '--delivered-outside-system',
      ],
      s.services,
    );
    expect(out.asked).toEqual([]);
    expect(s.issue).not.toHaveBeenCalled();
    expect(s.resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirmOutsideSystem: true }),
    );
  });

  it('a re-run on an order already out of review asks nothing', async () => {
    const s = resolveServices({ status: 'REFUNDED' });
    const out = await run(
      ['order:resolve', ORDER, '--failed', '--proof', MANUAL, ...WHO],
      s.services,
    );
    expect(out.asked).toEqual([]);
    expect(s.issue).not.toHaveBeenCalled();
  });
});

describe('order:resolve effects (no database)', () => {
  it('CRITICAL when the tonWalletCompromised alert was not queued', async () => {
    const s = resolveServices({});
    s.resolve.mockResolvedValue({
      applied: true,
      orderId: ORDER,
      to: 'FAILED',
      auditId: 'a1',
      refundTiyin: 550_000n,
      refundEntryId: 'e1',
      effects: { ...EFFECTS, securityAlert: false },
    });
    const out = await run(
      ['order:resolve', ORDER, '--failed', '--proof', MANUAL, ...WHO],
      s.services,
      ['5500', CODE],
    );
    expect(out.code).toBe(0);
    expect(out.out).toContain('securityAlertQueued=false');
    expect(out.err.join('\n')).toContain('CRITICAL: the tonWalletCompromised alert was NOT queued');
  });

  it('a replay past the dedupe window says the effects were not sent again', async () => {
    const s = resolveServices({ status: 'REFUNDED' });
    s.resolve.mockResolvedValue({
      applied: false,
      orderId: ORDER,
      to: 'FAILED',
      auditId: 'a1',
      refundTiyin: null,
      refundEntryId: null,
      effects: null,
    });
    const out = await run(
      ['order:resolve', ORDER, '--failed', '--proof', MANUAL, ...WHO],
      s.services,
    );
    expect(out.code).toBe(0);
    expect(out.out).toContain('customerNotified=-');
    expect(out.err.join('\n')).toContain('NOT sent again');
  });
});

describe('fx:set (no database)', () => {
  function fx(flags: string) {
    const issue = jest.fn().mockResolvedValue({ challengeId: CHALLENGE, expiresInSec: 180 });
    const discard = jest.fn().mockResolvedValue(undefined);
    const set = jest.fn().mockResolvedValue({
      auditId: 'a1',
      row: { id: 'r1' },
      derived: null,
      derivedSkip: null,
      otpVerified: flags !== '',
      adminAction: true,
    });
    const preview = jest.fn().mockResolvedValue({
      pair: 'USDT_UZS',
      rate: '12800',
      previous: null,
      flags,
      derived: null,
      derivedSkip: 'x',
    });
    const services = new Map<unknown, unknown>([
      [FxAdminService, { preview, set }],
      [OwnerOtpIssuer, { issue, discard }],
    ]);
    return { issue, discard, set, services };
  }
  const argv = ['fx:set', '--pair', 'USDT_UZS', '--rate', '12800', ...WHO];

  it('no flags: nothing is asked', async () => {
    const s = fx('');
    const out = await run(argv, s.services);
    expect(out.code).toBe(0);
    expect(out.asked).toEqual([]);
    expect(s.set).toHaveBeenCalledWith(
      expect.not.objectContaining({ otp: expect.anything() as unknown }),
    );
  });

  it('flags: the rate is re-typed, then the code bound to the pair, rate and flags (amount 0)', async () => {
    const s = fx('USDT_UZS: no manual rate in 24 h');
    const out = await run(argv, s.services, ['12800', CODE]);
    expect(out.code).toBe(0);
    expect(s.issue).toHaveBeenCalledWith({
      action: 'fx:set',
      amountTiyin: 0n,
      target: 'fx USDT_UZS 12800',
      flags: 'USDT_UZS: no manual rate in 24 h',
    });
    expect(s.set).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmRate: '12800',
        otp: { challengeId: CHALLENGE, code: CODE },
      }),
    );
    expect(s.discard).toHaveBeenCalledWith(CHALLENGE);
    expect([...out.out, ...out.err].join('\n')).not.toContain(CODE);
  });

  it('a wrong re-typed rate sends no code (the service refuses it)', async () => {
    const s = fx('USDT_UZS: no manual rate in 24 h');
    await run(argv, s.services, ['128000']);
    expect(s.issue).not.toHaveBeenCalled();
    expect(s.set).toHaveBeenCalledWith(expect.objectContaining({ confirmRate: '128000' }));
  });
});
