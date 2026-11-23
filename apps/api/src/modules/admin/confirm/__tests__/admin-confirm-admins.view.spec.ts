import type { AdminUser } from '@repo/db';
import { AdminConfirmationBodySchema } from '@repo/shared';
import { AppError } from '../../../../common/exceptions/app-error';
import type { CardPauseService } from '../../../payments/card-pause.service';
import type { ReviewCreditService } from '../../../payments/review-credit.service';
import type { WalletAdminService } from '../../../wallet/wallet-admin.service';
import type { AdminUsersRepository } from '../../admins/admin-users.repository';
import type { AdminSessionRepository } from '../../auth/admin-session.repository';
import type { AdminPrincipal } from '../../common/admin-request';
import type { AdminPaymentsReadService } from '../../payments/admin-payments-read.service';
import { AdminConfirmAdminsView } from '../admin-confirm-admins.view';
import { AdminConfirmService } from '../admin-confirm.service';
import type { AdminOtpIssuer } from '../admin-otp.issuer';

// Phase 9 S9a: `POST /admin/confirmations` for the admin-management actions. A code is always
// issued (D-63 (4)) with no server flag, naming the target admin; what the action would refuse
// anyway (unknown target, taken Telegram id, an OWNER row) gets no code and spends no quota.

const NOW = new Date('2026-11-23T09:00:00.000Z');
const ID = 'cmtarget0000000000000001';
const OPERATOR = { id: ID, name: 'Op', telegramId: 5_550_001_234n, role: 'OPERATOR' } as AdminUser;

function setup(found: AdminUser | null = OPERATOR, role: AdminUser['role'] = 'OWNER') {
  const issuer = { issue: jest.fn().mockResolvedValue({ challengeId: 'c1', expiresInSec: 180 }) };
  const admins = {
    findById: jest.fn().mockResolvedValue(found),
    findByTelegramId: jest.fn().mockResolvedValue(found),
  };
  const sessions = {
    findById: jest.fn().mockResolvedValue(found === null ? null : { id: 's9', admin: found }),
  };
  const config = { ADMIN_CONFIRM_THRESHOLD_TIYIN: 100_000_000n };
  const view = new AdminConfirmAdminsView(
    admins as unknown as AdminUsersRepository,
    sessions as unknown as AdminSessionRepository,
    config,
  );
  const service = new AdminConfirmService(
    issuer as unknown as AdminOtpIssuer,
    {} as WalletAdminService,
    {} as ReviewCreditService,
    {} as CardPauseService,
    {} as AdminPaymentsReadService,
    config,
    { now: () => NOW },
    view,
  );
  const principal = {
    sessionId: 's1',
    admin: { id: 'cmowner00000000000000001', role } as AdminUser,
  } as AdminPrincipal;
  const ask = (raw: object) => service.create(principal, AdminConfirmationBodySchema.parse(raw));
  return { issuer, ask };
}

const fieldsOf = (error: unknown) => (error instanceof AppError ? error.details : undefined);

describe('admin-management confirmations (S9a)', () => {
  it('issues a code bound to the body, no server flag, the target admin in the message', async () => {
    const s = setup();
    await s.ask({ action: 'admins.update', targetId: ID, role: 'SUPPORT' });
    expect(s.issuer.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        serverFlags: [],
        subject: { admin: { name: 'Op', telegramId: 5_550_001_234n } },
      }),
    );
  });

  it('an OWNER row gets no code: OWNER_ROW', async () => {
    const s = setup({ ...OPERATOR, role: 'OWNER' });
    const error: unknown = await s
      .ask({ action: 'admins.update', targetId: ID, isActive: false })
      .catch((e: unknown) => e);
    expect(fieldsOf(error)).toEqual({ fields: [{ path: 'id', code: 'OWNER_ROW' }] });
    expect(s.issuer.issue).not.toHaveBeenCalled();
  });

  it('an OWNER’s sessions may be ended (Q7 b): a code is issued', async () => {
    const s = setup({ ...OPERATOR, role: 'OWNER' });
    await s.ask({ action: 'admins.sessionsRevoke', targetId: ID });
    await s.ask({ action: 'sessions.revoke', targetId: ID });
    expect(s.issuer.issue).toHaveBeenCalledTimes(2);
  });

  it('a taken Telegram id gets no code: ADMIN_EXISTS', async () => {
    const s = setup();
    const error: unknown = await s
      .ask({ action: 'admins.create', telegramId: '5550001234', name: 'New', role: 'SUPPORT' })
      .catch((e: unknown) => e);
    expect(fieldsOf(error)).toEqual({ fields: [{ path: 'telegramId', code: 'ADMIN_EXISTS' }] });
    expect(s.issuer.issue).not.toHaveBeenCalled();
  });

  it('a free Telegram id: the code names the masked id it asks for', async () => {
    const s = setup(null);
    await s.ask({
      action: 'admins.create',
      telegramId: '5550001234',
      name: 'New',
      role: 'SUPPORT',
    });
    expect(s.issuer.issue).toHaveBeenCalledWith(
      expect.objectContaining({ subject: { admin: { name: null, telegramId: 5_550_001_234n } } }),
    );
  });

  it('an unknown admin or session is 404, and OPERATOR never gets an admin code', async () => {
    const gone = setup(null);
    await expect(
      gone.ask({ action: 'admins.update', targetId: ID, name: 'X' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(gone.ask({ action: 'sessions.revoke', targetId: ID })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const operator = setup(OPERATOR, 'OPERATOR');
    await expect(
      operator.ask({ action: 'admins.sessionsRevoke', targetId: ID }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(operator.issuer.issue).not.toHaveBeenCalled();
  });
});
