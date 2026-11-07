import { OwnerOtpIssuer } from '../../common/admin/owner-otp/owner-otp.issuer';
import { ReviewCreditService } from '../../modules/payments/review-credit.service';
import { ReviewEffects } from '../../modules/payments/review-effects';
import { WalletAdminService } from '../../modules/wallet/wallet-admin.service';
import { sessionOf } from '../cli-session';
import { NOOP_CHANGE, WHO, runFake as run } from './fake-cli';

const CHALLENGE = 'c'.repeat(32);
const CODE = '481516';

function wallet() {
  const adjust = jest.fn().mockResolvedValue(NOOP_CHANGE);
  const issue = jest.fn().mockResolvedValue({ challengeId: CHALLENGE, expiresInSec: 180 });
  const discard = jest.fn().mockResolvedValue(undefined);
  const services = new Map<unknown, unknown>([
    [WalletAdminService, { adjust }],
    [OwnerOtpIssuer, { issue, discard }],
    [ReviewEffects, { adminAction: jest.fn().mockResolvedValue(true) }],
  ]);
  return { adjust, issue, discard, services };
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
