import type { AdminCreateBody } from '@repo/shared';
import { OTP, REASON, WHO, row, setup } from './admin-panel-accounts.fake';

// Phase 9 S9a: adding an admin from the panel, in isolation (a taken id, the unique index race).

describe('AdminPanelAccountsService.create', () => {
  it('create: a taken Telegram id is ADMIN_EXISTS and nothing is created', async () => {
    const s = setup();
    s.admins.findByTelegramId.mockResolvedValueOnce(row());
    const asked: AdminCreateBody = {
      telegramId: '1234567890',
      name: 'New',
      role: 'SUPPORT',
      reason: REASON,
      otp: OTP,
    };
    await expect(s.service.create(s.actor, asked)).rejects.toMatchObject({
      details: { field: 'telegramId', reason: 'ADMIN_EXISTS' },
    });
    expect(s.admins.create).not.toHaveBeenCalled();
  });

  const ASKED: AdminCreateBody = {
    telegramId: '5550001234',
    name: 'New',
    role: 'SUPPORT',
    reason: REASON,
    otp: OTP,
  };

  it('a new SUPPORT: one ADMIN_CREATE row with exactly its fields, the code and the actor', async () => {
    const s = setup();
    const res = await s.service.create(s.actor, ASKED);
    expect(res).toMatchObject({ applied: true, auditId: s.actor.request.auditId });
    expect(s.audits[0]).toMatchObject({ action: 'ADMIN_CREATE', before: null });
    expect(s.audits[0]?.after).toEqual({
      telegramId: '5550001234',
      name: 'New',
      role: 'SUPPORT',
      isActive: true,
      allowlisted: false,
      ...WHO,
    });
    expect(s.alerts.adminAction).toHaveBeenCalledTimes(1);
  });

  it('a parallel add won the unique index after our read (P2002): ADMIN_EXISTS, no alert', async () => {
    const s = setup();
    // The shape Prisma 7 with the pg adapter throws (db-errors.ts).
    const unique = Object.assign(new Error('unique'), {
      code: 'P2002',
      meta: {
        driverAdapterError: { cause: { constraint: { index: 'AdminUser_telegramId_key' } } },
      },
    });
    s.admins.create.mockRejectedValueOnce(unique);
    await expect(s.service.create(s.actor, ASKED)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'telegramId', reason: 'ADMIN_EXISTS' },
    });
    expect(s.alerts.adminAction).not.toHaveBeenCalled();

    // Any other index is not this refusal: it passes unchanged.
    const other = setup();
    const foreign = Object.assign(new Error('other'), {
      code: 'P2002',
      meta: { driverAdapterError: { cause: { constraint: { index: 'AuditLog_pkey' } } } },
    });
    other.admins.create.mockRejectedValueOnce(foreign);
    await expect(other.service.create(other.actor, ASKED)).rejects.toBe(foreign);
  });
});
