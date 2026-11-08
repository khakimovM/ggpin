import { OwnerOtpIssuer } from '../../common/admin/owner-otp/owner-otp.issuer';
import { ReviewCreditService } from '../../modules/payments/review-credit.service';
import { ReviewEffects } from '../../modules/payments/review-effects';
import { validationError } from '../../common/admin/admin-input';
import { adjustOtpFlags, recentSetHash } from '../../modules/wallet/wallet-admin.input';
import { WalletAdminService } from '../../modules/wallet/wallet-admin.service';
import { sessionOf } from '../cli-session';
import { NOOP_CHANGE, WHO, runFake as run } from './fake-cli';

const CHALLENGE = 'c'.repeat(32);
const CODE = '481516';

function wallet() {
  const adjust = jest.fn().mockResolvedValue(NOOP_CHANGE);
  const recentFor = jest.fn().mockResolvedValue([]);
  const issue = jest.fn().mockResolvedValue({ challengeId: CHALLENGE, expiresInSec: 180 });
  const discard = jest.fn().mockResolvedValue(undefined);
  const services = new Map<unknown, unknown>([
    [WalletAdminService, { adjust, recentFor }],
    [OwnerOtpIssuer, { issue, discard }],
    [ReviewEffects, { adminAction: jest.fn().mockResolvedValue(true) }],
  ]);
  return { adjust, recentFor, issue, discard, services };
}

const BIG = ['wallet:adjust', '--user', 'u1', '--amount=-2000000', '--key', 'k1', ...WHO];

describe('owner CLI: confirmation above the threshold (D-46), --key, who ran it', () => {
  it('re-typed amount, then the bot code (not echoed); both reach the service; the code is discarded after', async () => {
    const w = wallet();
    const big = await run(BIG, w.services, ['-2000000', CODE]);
    expect(big.code).toBe(0);
    expect(big.asked).toHaveLength(2);
    expect(w.issue).toHaveBeenCalledWith({
      action: 'wallet:adjust',
      amountTiyin: -200_000_000n,
      target: 'user u1 key k1',
    });
    expect(w.adjust).toHaveBeenLastCalledWith(
      expect.objectContaining({
        amountTiyin: -200_000_000n,
        confirmAmountTiyin: -200_000_000n,
        otp: { challengeId: CHALLENGE, code: CODE },
        auditId: 'k1',
      }),
    );
    expect(w.discard).toHaveBeenCalledWith(CHALLENGE);
    // Neither the code nor the challenge is ever printed.
    const printed = [...big.out, ...big.err].join('\n');
    expect(printed).not.toContain(CODE);
    expect(printed).not.toContain(CHALLENGE);
  });

  it('review:credit binds the code to --confirm-override and --bank-verified and shows them (S8 R2)', async () => {
    const w = wallet();
    const preview = jest.fn().mockResolvedValue({
      amountTiyin: 200_000_000n,
      userId: 'u1',
      needsBankVerification: true,
      overrideNeeded: 'NEW_ACCOUNT_DAILY_LIMIT',
      manualCreditsSinceRequest: {
        adjust: { count: 0, sumTiyin: 0n },
        reviewCredit: { count: 0, sumTiyin: 0n },
        since: new Date(0),
      },
      user: {
        blocked: false,
        purchaseFrozen: false,
        accountAgeSec: 0,
        usedBaseTiyin: 0n,
        requestedBaseTiyin: 200_000_000n,
        limitTiyin: 50_000_000n,
        limitReason: 'NEW_ACCOUNT_DAILY_LIMIT',
        overLimit: true,
      },
    });
    const credit = jest.fn().mockResolvedValue({
      reviewId: 'r1',
      paymentId: 'p1',
      userId: 'u1',
      intentId: null,
      amountTiyin: 200_000_000n,
      auditId: 'a1',
      notified: true,
    });
    w.services.set(ReviewCreditService, { preview, credit });
    const argv = ['review:credit', 'r1', '--user', 'u1', '--confirm-override', '--bank-verified'];
    const result = await run([...argv, ...WHO], w.services, ['2000000', CODE]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('confirms=override: overLimit; bank-verified');
    expect(w.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'review:credit',
        flags: 'override: overLimit; bank-verified',
      }),
    );
    expect(credit).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmOverride: true,
        bankVerified: true,
        otp: { challengeId: CHALLENGE, code: CODE },
      }),
    );
  });

  it('wallet:adjust after an automatic top-up of the horizon: shown with its set id, refused without it', async () => {
    const w = wallet();
    const at = new Date('2026-11-08T10:00:00.000Z');
    const recent = [{ id: 'p1', amountTiyin: 5_012_300n, confirmedAt: at }];
    w.recentFor.mockResolvedValue(recent);
    const set = recentSetHash(recent);
    const flags = adjustOtpFlags(recent, true);
    const plus = ['wallet:adjust', '--user', 'u1', '--amount', '2000000', '--key', 'k1', ...WHO];
    const refused = await run(plus, w.services, ['2000000', CODE]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('recentAutoTopup=p1 +50123 UZS at 2026-11-08T10:00:00.000Z');
    expect(refused.out).toContain(`recentAutoTopupSet=${set}`);
    expect(refused.err.join(' ')).toContain('--confirm-override=<recentAutoTopupSet>');
    expect(refused.asked).toHaveLength(0); // refused before any code is sent
    expect(w.issue).not.toHaveBeenCalled();
    expect(w.adjust).not.toHaveBeenCalled();

    // With the set id the code is bound to it (D-46) and the service gets the same id.
    const done = await run([...plus, `--confirm-override=${set}`], w.services, ['2000000', CODE]);
    expect(done.code).toBe(0);
    expect(flags).toMatch(/^override: 1 recent auto top-up\(s\), set [0-9a-f]{12}$/);
    expect(done.out).toContain(`confirms=${flags}`);
    expect(w.issue).toHaveBeenCalledWith(expect.objectContaining({ flags }));
    expect(w.adjust).toHaveBeenLastCalledWith(expect.objectContaining({ confirmOverrideSet: set }));
  });

  it('S9F-L1: a set id of another set is refused below the threshold too, before any write', async () => {
    const w = wallet();
    const recent = [{ id: 'p2', amountTiyin: 100n, confirmedAt: null }];
    w.recentFor.mockResolvedValue(recent);
    const stale = recentSetHash([{ id: 'p1', amountTiyin: 100n, confirmedAt: null }]);
    const small = ['wallet:adjust', '--user', 'u1', '--amount', '5', '--key', 'k1', ...WHO];
    const refused = await run([...small, `--confirm-override=${stale}`], w.services);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain(`recentAutoTopupSet=${recentSetHash(recent)}`);
    expect(w.adjust).not.toHaveBeenCalled();
  });

  it('S9F-L1 / m2 / n3: a bare flag (at the end or mid-argv) or a malformed set id: code 2, a clear text', async () => {
    const head = ['wallet:adjust', '--user', 'u1', '--amount', '5', '--key', 'k1'];
    const cases = [
      [...head, ...WHO, '--confirm-override'],
      [...head, '--confirm-override', ...WHO], // n3: the next option must not become its value
      [...head, ...WHO, '--confirm-override=TRUE'],
      [...head, ...WHO, '--confirm-override=abc'],
    ];
    for (const argv of cases) {
      const w = wallet();
      w.recentFor.mockResolvedValue([{ id: 'p1', amountTiyin: 100n, confirmedAt: null }]);
      const result = await run(argv, w.services);
      expect(result.code).toBe(2);
      expect(result.err.join(' ')).toContain(
        'takes a VALUE: --confirm-override=<recentAutoTopupSet>',
      );
      expect(result.err.join(' ')).toContain('in review:credit and card:resume it is a bare flag');
      expect(w.recentFor).not.toHaveBeenCalled();
      expect(w.adjust).not.toHaveBeenCalled();
    }
  });

  it('I-3: the refusal says this run wrote nothing and to re-run with the new set and the SAME --key', async () => {
    const w = wallet();
    w.recentFor.mockResolvedValue([{ id: 'p1', amountTiyin: 100n, confirmedAt: null }]);
    const small = ['wallet:adjust', '--user', 'u1', '--amount', '5', '--key', 'k1', ...WHO];
    const err = (await run(small, w.services)).err.join(' ');
    expect(err).toContain(
      'this run wrote nothing; an earlier run with this --key may have written',
    );
    expect(err).toContain(
      'the new set and the same --key: --confirm-override=<recentAutoTopupSet> --key k1',
    );
  });

  it('n1: OTP_MISMATCH after the set changed: the new list and the reason are shown', async () => {
    const w = wallet();
    const first = [{ id: 'p1', amountTiyin: 100n, confirmedAt: null }];
    const both = [...first, { id: 'p2', amountTiyin: 200n, confirmedAt: null }];
    w.recentFor.mockResolvedValueOnce(first).mockResolvedValue(both);
    w.adjust.mockRejectedValue(validationError('otp', 'OTP_MISMATCH'));
    const plus = ['wallet:adjust', '--user', 'u1', '--amount', '2000000', '--key', 'k1', ...WHO];
    const argv = [...plus, `--confirm-override=${recentSetHash(first)}`];
    const result = await run(argv, w.services, ['2000000', CODE]);
    expect(result.code).toBe(1);
    const err = result.err.join(' ');
    expect(err).toContain('the owner code does not match');
    expect(err).toContain('changed after the code was sent: it was bound to the old set');
    expect(result.out).toContain(`recentAutoTopupSet=${recentSetHash(both)}`);
  });

  it('S9F-L1: a top-up between the read and the lock: the service refuses, the new list and set are shown', async () => {
    const w = wallet();
    const first = [{ id: 'p1', amountTiyin: 100n, confirmedAt: null }];
    const both = [...first, { id: 'p2', amountTiyin: 200n, confirmedAt: null }];
    w.recentFor.mockResolvedValueOnce(first).mockResolvedValue(both);
    w.adjust.mockRejectedValue(validationError('user', 'RECENT_AUTO_TOPUP'));
    const small = ['wallet:adjust', '--user', 'u1', '--amount', '5', '--key', 'k1', ...WHO];
    const result = await run([...small, `--confirm-override=${recentSetHash(first)}`], w.services);
    expect(result.code).toBe(1);
    expect(result.err.join(' ')).toContain('changed meanwhile');
    expect(result.out).toContain('recentAutoTopup=p2 +2 UZS at -');
    expect(result.out).toContain(`recentAutoTopupSet=${recentSetHash(both)}`);
  });

  it('a wrong re-typed amount sends no code; the service refuses it as it is', async () => {
    const w = wallet();
    await run(BIG, w.services, ['-200000']);
    expect(w.issue).not.toHaveBeenCalled();
    expect(w.adjust).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirmAmountTiyin: -20_000_000n }),
    );
    expect(w.adjust).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ otp: expect.anything() as unknown }),
    );
  });

  it('a refused service call still discards the code', async () => {
    const w = wallet();
    w.adjust.mockRejectedValueOnce(new Error('boom'));
    expect((await run(BIG, w.services, ['-2000000', CODE])).code).toBe(1);
    expect(w.discard).toHaveBeenCalledWith(CHALLENGE);
  });

  it('wallet:adjust without --key writes nothing and prints a fresh key to run again with (S8-M1)', async () => {
    const w = wallet();
    const argv = ['wallet:adjust', '--user', 'u1', '--amount', '5', ...WHO];
    const first = await run(argv, w.services);
    const second = await run(argv, w.services);
    expect(first.code).toBe(1);
    expect(w.adjust).not.toHaveBeenCalled();
    const key = (r: { err: string[] }) => /--key ([0-9a-f]{32})/.exec(r.err.join('\n'))?.[1];
    expect(key(first)).toBeDefined();
    expect(key(first)).not.toBe(key(second));
  });

  it('the SSH client address is the audit ip; a different --ip is refused, the same one is fine (S8-L5)', async () => {
    const w = wallet();
    const ssh = { sshIp: '198.51.100.4', osUser: 'deploy (sudo from aziz)' };
    const small = ['wallet:adjust', '--user', 'u1', '--amount', '5', '--key', 'k1', ...WHO];
    expect((await run(small, w.services, [], ssh)).code).toBe(0);
    expect(w.adjust).toHaveBeenLastCalledWith(
      expect.objectContaining({ ip: '198.51.100.4', osUser: 'deploy (sudo from aziz)' }),
    );
    expect((await run([...small, '--ip', '203.0.113.1'], w.services, [], ssh)).code).toBe(2);
    expect((await run([...small, '--ip', '198.51.100.4'], w.services, [], ssh)).code).toBe(0);
    // Without SSH the typed address is used.
    const local = { sshIp: null, osUser: 'aziz' };
    expect((await run([...small, '--ip', '203.0.113.1'], w.services, [], local)).code).toBe(0);
    expect(w.adjust).toHaveBeenLastCalledWith(expect.objectContaining({ ip: '203.0.113.1' }));
  });

  it('sessionOf reads SSH_CONNECTION, then SSH_CLIENT, and the sudo caller', () => {
    expect(sessionOf({ SSH_CONNECTION: '198.51.100.4 51022 10.0.0.2 22' }, 'root')).toEqual({
      sshIp: '198.51.100.4',
      osUser: 'root',
    });
    expect(sessionOf({ SSH_CLIENT: '2001:db8::7 51022 22', SUDO_USER: 'aziz' }, 'root')).toEqual({
      sshIp: '2001:db8::7',
      osUser: 'root (sudo from aziz)',
    });
    expect(sessionOf({ SSH_CONNECTION: 'garbage' }, null)).toEqual({ sshIp: null, osUser: null });
  });
});
