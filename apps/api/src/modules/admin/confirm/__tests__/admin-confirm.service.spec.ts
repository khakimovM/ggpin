import type { AdminUser } from '@repo/db';
import type { AdminConfirmationBody } from '@repo/shared';
import type { Clock } from '../../../../common/clock/clock';
import type { CardPauseService } from '../../../payments/card-pause.service';
import type { ReviewCreditService } from '../../../payments/review-credit.service';
import { recentSetHash } from '../../../wallet/wallet-admin.input';
import type { WalletAdminService } from '../../../wallet/wallet-admin.service';
import { openOrdersSetHash, type OpenOrder } from '../../../wallet/wallet-open-orders';
import type { AdminPrincipal } from '../../common/admin-request';
import type { AdminPaymentsReadService } from '../../payments/admin-payments-read.service';
import type { AdminConfirmAdminsView } from '../admin-confirm-admins.view';
import { AdminConfirmService } from '../admin-confirm.service';
import type { AdminOtpIssuer } from '../admin-otp.issuer';

// Phase 9 S7a-fix (owner decision 2026-11-22): `users.adjustWallet` gets no code while the recent
// auto top-ups' or the open orders' set is unconfirmed or stale; the issuer (which counts the
// daily limit and queues the bot message) is never reached, and the refusal is the action's own.

const NOW = new Date('2026-11-22T09:00:00.000Z');
const ORDER: OpenOrder = {
  id: 'o1',
  number: 7,
  status: 'HELD',
  priceTiyin: 1_600_000n,
  createdAt: NOW,
};
const TOPUP = { id: 'p1', amountTiyin: 2_000_000n, confirmedAt: NOW };

function setup() {
  const issuer = { issue: jest.fn().mockResolvedValue({ challengeId: 'c1' }) };
  const wallet = {
    confirmTarget: jest.fn().mockResolvedValue(undefined),
    recentFor: jest.fn().mockResolvedValue([]),
    openFor: jest.fn().mockResolvedValue([]),
    codelessFlags: jest.fn().mockResolvedValue([]),
  };
  const clock: Clock = { now: () => NOW };
  const service = new AdminConfirmService(
    issuer as unknown as AdminOtpIssuer,
    wallet as unknown as WalletAdminService,
    {} as ReviewCreditService,
    {} as CardPauseService,
    {} as AdminPaymentsReadService,
    { ADMIN_CONFIRM_THRESHOLD_TIYIN: 100_000_000n },
    clock,
    {} as AdminConfirmAdminsView,
  );
  const principal = {
    sessionId: 's1',
    admin: { id: 'admin1', role: 'OWNER' } as AdminUser,
  } as AdminPrincipal;
  return { service, issuer, wallet, principal };
}

const body = (extra: Partial<AdminConfirmationBody> = {}): AdminConfirmationBody =>
  ({
    action: 'users.adjustWallet',
    targetId: 'u1',
    amountTiyin: '10000',
    idempotencyKey: 'key-1',
    ...extra,
  }) as AdminConfirmationBody;

const refusedWith = (code: string) => ({
  code: 'VALIDATION_ERROR',
  details: { fields: [{ path: 'user', code }] },
});

describe('AdminConfirmService users.adjustWallet: early set refusals', () => {
  it('open orders without the set: 400 OPEN_ORDERS, no code issued', async () => {
    const { service, issuer, wallet, principal } = setup();
    wallet.openFor.mockResolvedValue([ORDER]);
    await expect(service.create(principal, body())).rejects.toMatchObject(
      refusedWith('OPEN_ORDERS'),
    );
    expect(issuer.issue).not.toHaveBeenCalled();
  });

  it('CR #2: the set given, the order closed since: 400 OPEN_ORDERS, no code issued', async () => {
    const { service, issuer, principal } = setup();
    const seen = body({ confirmOpenOrdersSet: openOrdersSetHash([ORDER]) });
    await expect(service.create(principal, seen)).rejects.toMatchObject(refusedWith('OPEN_ORDERS'));
    expect(issuer.issue).not.toHaveBeenCalled();
  });

  it('recent auto top-ups without the override: 400 RECENT_AUTO_TOPUP, no code issued', async () => {
    const { service, issuer, wallet, principal } = setup();
    wallet.recentFor.mockResolvedValue([TOPUP]);
    await expect(service.create(principal, body())).rejects.toMatchObject(
      refusedWith('RECENT_AUTO_TOPUP'),
    );
    expect(issuer.issue).not.toHaveBeenCalled();
  });

  it('both exact sets: the code is issued, bound to the server flags of both', async () => {
    const { service, issuer, wallet, principal } = setup();
    wallet.recentFor.mockResolvedValue([TOPUP]);
    wallet.openFor.mockResolvedValue([ORDER]);
    const sets = {
      confirmOverrideSet: recentSetHash([TOPUP]),
      confirmOpenOrdersSet: openOrdersSetHash([ORDER]),
    };
    await expect(service.create(principal, body(sets))).resolves.toEqual({ challengeId: 'c1' });
    expect(issuer.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        serverFlags: [
          `override: 1 recent auto top-up(s), set ${sets.confirmOverrideSet}; ` +
            `open orders: 1 open order(s), set ${sets.confirmOpenOrdersSet}`,
        ],
      }),
    );
  });

  it('a debit is not refused for open orders: OTP_NOT_REQUIRED decides', async () => {
    const { service, issuer, principal } = setup();
    const debit = body({ amountTiyin: '-5', confirmOpenOrdersSet: openOrdersSetHash([ORDER]) });
    await expect(service.create(principal, debit)).rejects.toMatchObject({
      details: { fields: [{ path: 'action', code: 'OTP_NOT_REQUIRED' }] },
    });
    expect(issuer.issue).not.toHaveBeenCalled();
  });
});
