import { AUTO_CREDIT_HORIZON_MS } from '@repo/db';
import { RECENT_AUTO_TOPUP_WINDOW_MS, adjustOtpFlags, recentSetHash } from '../wallet-admin.input';
import { OPERATOR, THRESHOLD, setup } from './wallet-admin.fixtures';

const adjustInput = {
  userId: 'u1',
  amountTiyin: 500_000n,
  reason: 'support credit',
  ...OPERATOR,
};

const OTP = { challengeId: '0'.repeat(32), code: '123456' };

describe('WalletAdminService.adjust after an automatic top-up (S9 F-L1, S9F-L1)', () => {
  const RECENT = [{ id: 'p9', amountTiyin: 5_012_300n, confirmedAt: new Date(0) }];
  const SET = recentSetHash(RECENT);
  const refused = { details: { field: 'user', reason: 'RECENT_AUTO_TOPUP' } };

  it('a positive adjustment is refused under the lock without the override; nothing is written', async () => {
    const { service, repo } = setup();
    repo.recentAutoTopups.mockResolvedValue(RECENT);
    await expect(service.adjust(adjustInput)).rejects.toMatchObject(refused);
    expect(repo.lock).toHaveBeenCalled();
    expect(repo.createAudit).not.toHaveBeenCalled();
    expect(repo.appendEntry).not.toHaveBeenCalled();
  });

  it('the override with the set id it was shown: written, the ids and the override in AuditLog.after', async () => {
    const { service, repo } = setup();
    repo.recentAutoTopups.mockResolvedValue(RECENT);
    await service.adjust({ ...adjustInput, confirmOverrideSet: SET });
    expect(repo.createAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        after: expect.objectContaining({ override: true, recentAutoTopups: ['p9'] }) as unknown,
      }),
    );
  });

  it('S9F-L1, below the threshold: a top-up arrived between the refusal and the override: refused again', async () => {
    const { service, repo } = setup();
    const credited = { id: 'p10', amountTiyin: 5_012_300n, confirmedAt: new Date(0) };
    repo.recentAutoTopups.mockResolvedValue([...RECENT, credited]); // S1 = S0 + M
    await expect(service.adjust({ ...adjustInput, confirmOverrideSet: SET })).rejects.toMatchObject(
      refused,
    );
    expect(repo.appendEntry).not.toHaveBeenCalled();
  });

  it('an override that is not a 12-hex set id is a validation error, before anything is read', async () => {
    const { service, repo } = setup();
    for (const bad of ['', 'true', SET.toUpperCase(), `${SET}0`]) {
      await expect(
        service.adjust({ ...adjustInput, confirmOverrideSet: bad }),
      ).rejects.toMatchObject({ details: { field: 'confirmOverrideSet' } });
    }
    expect(repo.lock).not.toHaveBeenCalled();
  });

  it('a negative adjustment never reads the top-ups', async () => {
    const { service, repo } = setup();
    repo.recentAutoTopups.mockResolvedValue(RECENT);
    await service.adjust({ ...adjustInput, amountTiyin: -500_000n });
    expect(repo.recentAutoTopups).not.toHaveBeenCalled();
  });

  it('above the threshold the code is also bound to the set (D-46); a set change after the code is OTP_MISMATCH', async () => {
    const { service, repo, otp } = setup(THRESHOLD * 2n);
    const big = { ...adjustInput, amountTiyin: THRESHOLD + 1n, confirmAmountTiyin: THRESHOLD + 1n };
    // Same count, another payment (N1): the owner re-ran with the new set id, the code is old.
    const other = [{ id: 'p10', amountTiyin: 5_012_300n, confirmedAt: new Date(0) }];
    expect(adjustOtpFlags(other, true)).not.toBe(adjustOtpFlags(RECENT, true));
    repo.recentAutoTopups.mockResolvedValueOnce(RECENT).mockResolvedValueOnce(other);
    const otherSet = recentSetHash(other);
    await expect(
      service.adjust({ ...big, otp: OTP, confirmOverrideSet: otherSet }),
    ).rejects.toMatchObject({ details: { field: 'otp', reason: 'OTP_MISMATCH' } });
    expect(otp.verifyIfGiven).toHaveBeenLastCalledWith(
      OTP,
      THRESHOLD + 1n,
      'wallet:adjust',
      'user u1 key -',
      adjustOtpFlags(RECENT, true),
    );
    expect(repo.appendEntry).not.toHaveBeenCalled();
  });

  it('S9F-L2: the window is the whole worker auto-credit horizon (orphan re-queue lookback)', () => {
    expect(RECENT_AUTO_TOPUP_WINDOW_MS).toBeGreaterThanOrEqual(AUTO_CREDIT_HORIZON_MS);
    expect(AUTO_CREDIT_HORIZON_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
