import { AdminAdjustPreviewResponseSchema, adminOtpRequired } from '@repo/shared';
import type { Clock } from '../../../../common/clock/clock';
import type { AppConfig } from '../../../../config/config.module';
import { recentSetHash } from '../../../wallet/wallet-admin.input';
import type { WalletAdminService } from '../../../wallet/wallet-admin.service';
import { openOrdersSetHash } from '../../../wallet/wallet-open-orders';
import type { WalletRepository } from '../../../wallet/wallet.repository';
import { AdminAdjustPreviewService, adjustOtpReason } from '../admin-adjust-preview.service';

// Phase 9 S7a: the preview is the action's own reads in the contract shape (docs/04
// «adjust-preview»); its otpReason never disagrees with the matrix rule.

const THRESHOLD = 100_000_000n;
const CAP = 500_000_000n;
const NOW = new Date('2026-11-22T10:00:00.000Z');
const RECENT = [
  { id: 'p1', amountTiyin: 2_012_300n, confirmedAt: new Date('2026-11-21T08:00:00Z') },
];
const OPEN = [
  {
    id: 'o1',
    number: 42,
    status: 'HELD' as const,
    priceTiyin: 1_600_000n,
    createdAt: new Date('2026-11-22T09:00:00Z'),
  },
];

function setup() {
  const wallet = {
    confirmTarget: jest.fn().mockResolvedValue(undefined),
    recentFor: jest.fn((_u: string, amount: bigint) => Promise.resolve(amount > 0n ? RECENT : [])),
    openFor: jest.fn((_u: string, amount: bigint) => Promise.resolve(amount > 0n ? OPEN : [])),
    codelessFlags: jest.fn().mockResolvedValue([]),
  };
  const repo = {
    balance: jest.fn().mockResolvedValue(-500n),
    manualCreditTotalSinceUnlocked: jest.fn().mockResolvedValue(30_000n),
  };
  const config = {
    ADMIN_CONFIRM_THRESHOLD_TIYIN: THRESHOLD,
    ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN: CAP,
  } as unknown as AppConfig;
  const clock: Clock = { now: () => NOW };
  const service = new AdminAdjustPreviewService(
    wallet as unknown as WalletAdminService,
    repo as unknown as WalletRepository,
    config,
    clock,
  );
  return { service, wallet, repo };
}

describe('AdminAdjustPreviewService', () => {
  it('a credit: both sets, the code always, money as strings, the contract shape', async () => {
    const { service, wallet } = setup();
    const view = await service.preview('adm1', 'u1', 100_000n);
    expect(AdminAdjustPreviewResponseSchema.parse(view)).toEqual({
      balanceTiyin: '-500',
      newBalanceTiyin: '99500',
      otpRequired: true,
      otpReason: 'CREDIT',
      recentAutoTopups: [
        { paymentId: 'p1', amountTiyin: '2012300', confirmedAt: '2026-11-21T08:00:00.000Z' },
      ],
      confirmOverrideSet: recentSetHash(RECENT),
      openOrders: [
        {
          id: 'o1',
          number: 42,
          status: 'HELD',
          priceTiyin: '1600000',
          createdAt: '2026-11-22T09:00:00.000Z',
        },
      ],
      confirmOpenOrdersSet: openOrdersSetHash(OPEN),
      manualCreditToday: { usedTiyin: '30000', capTiyin: '500000000' },
    });
    expect(wallet.confirmTarget).toHaveBeenCalledWith('adm1', 'u1');
    expect(wallet.codelessFlags).not.toHaveBeenCalled();
  });

  it('a small debit: no sets, no code until the codeless budget is passed', async () => {
    const { service, wallet } = setup();
    const small = await service.preview('adm1', 'u1', -5_000n);
    expect(small).toMatchObject({
      newBalanceTiyin: '-5500',
      otpRequired: false,
      otpReason: null,
      recentAutoTopups: [],
      confirmOverrideSet: null,
      openOrders: [],
      confirmOpenOrdersSet: null,
    });
    expect(wallet.codelessFlags).toHaveBeenCalledWith('adm1', -5_000n, NOW);
    wallet.codelessFlags.mockResolvedValue(['otpRequired: daily-limit']);
    expect(await service.preview('adm1', 'u1', -5_000n)).toMatchObject({
      otpRequired: true,
      otpReason: 'DAILY_BUDGET',
    });
    expect(await service.preview('adm1', 'u1', -(THRESHOLD + 1n))).toMatchObject({
      otpRequired: true,
      otpReason: 'ABOVE_THRESHOLD',
    });
  });

  it('a refused target is refused before any other read', async () => {
    const { service, wallet, repo } = setup();
    wallet.confirmTarget.mockRejectedValue(new Error('SELF_TARGET'));
    await expect(service.preview('adm1', 'u1', 1n)).rejects.toThrow('SELF_TARGET');
    expect(repo.balance).not.toHaveBeenCalled();
  });
});

describe('adjustOtpReason agrees with adminOtpRequired', () => {
  it.each([
    [1n, false],
    [THRESHOLD + 5n, false],
    [-1n, false],
    [-1n, true],
    [-THRESHOLD, false],
    [-THRESHOLD, true],
    [-(THRESHOLD + 1n), false],
  ])('amount %s, budget passed %s', (amountTiyin, budget) => {
    const required = adminOtpRequired('users.adjustWallet', {
      amountTiyin,
      thresholdTiyin: THRESHOLD,
      codelessBudgetExceeded: budget,
    });
    expect(adjustOtpReason(amountTiyin, THRESHOLD, budget) !== null).toBe(required);
  });
});
