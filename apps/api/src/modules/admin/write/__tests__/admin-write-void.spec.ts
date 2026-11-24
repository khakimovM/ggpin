import type { AdminUser } from '@repo/db';
import type { AdminWriteKeyVoidBody } from '@repo/shared';
import type { AdminActor } from '../../../../common/admin/audit-actor';
import { AppError } from '../../../../common/exceptions/app-error';
import type { Db } from '../../../../infra/prisma/db';
import type { AdminPrincipal } from '../../common/admin-request';
import type { AdminOtpVerifier } from '../../confirm/admin-otp.verifier';
import { adminAuditIdFor, adminRequestHash } from '../admin-write-key';
import { AdminWriteVoidService, VOID_TX_TIMEOUT_MS } from '../admin-write-void.service';
import type {
  AdminAuditRow,
  AdminTombstone,
  AdminWriteRepository,
} from '../admin-write.repository';
import { AdminWriteRunner } from '../admin-write.runner';

// 9-B SA-1 unit level: the void's answer from the key's audit row, its actor check, and the
// runner's explicit tombstone branch (docs/04 «Idempotency-Key» (d), «Kalitni bekor qilish»).
const NOW = new Date('2026-11-23T10:00:00.000Z');
const ADMIN_ID = 'cmadmin0void0unit000000001';
const SESSION_ID = 'cmsession0void0unit0000001';
const BODY: AdminWriteKeyVoidBody = {
  idempotencyKey: 'void-unit-key-0001',
  action: 'users.adjustWallet',
  targetId: 'cmuser0void0unit000000001',
};
const AUDIT_ID = adminAuditIdFor(ADMIN_ID, BODY.idempotencyKey);

const principal = (role: AdminUser['role'] = 'OWNER'): AdminPrincipal =>
  ({ sessionId: SESSION_ID, admin: { id: ADMIN_ID, role } }) as AdminPrincipal;

interface World {
  admin: { role: string; isActive: boolean } | null;
  sessionOpen: boolean;
  existing: AdminAuditRow | null;
}

function row(action: string, extra: Partial<AdminAuditRow> = {}): AdminAuditRow {
  return {
    id: AUDIT_ID,
    actorType: 'ADMIN',
    actorId: ADMIN_ID,
    action,
    targetId: BODY.targetId,
    after: {},
    createdAt: NOW,
    ...extra,
  };
}

function harness(world: World) {
  const inserted: AdminTombstone[] = [];
  const tx = {
    $queryRaw: () =>
      Promise.resolve(world.admin === null ? [] : [{ id: ADMIN_ID, ...world.admin }]),
    adminSession: {
      findUnique: () =>
        Promise.resolve({
          adminId: ADMIN_ID,
          revokedAt: world.sessionOpen ? null : NOW,
          expiresAt: new Date(NOW.getTime() + 3_600_000),
        }),
    },
  } as unknown as Db;
  const repo = {
    transaction: jest.fn((fn: (db: Db) => Promise<unknown>, timeoutMs: number) => {
      expect(timeoutMs).toBe(VOID_TX_TIMEOUT_MS);
      return fn(tx);
    }),
    insertTombstone: jest.fn((_tx: Db, tombstone: AdminTombstone) => {
      if (world.existing !== null) return Promise.resolve(false);
      inserted.push(tombstone);
      world.existing = row(tombstone.action, { after: tombstone.after as AdminAuditRow['after'] });
      return Promise.resolve(true);
    }),
    findAudit: jest.fn(() => Promise.resolve(world.existing)),
  };
  const service = new AdminWriteVoidService(repo as unknown as AdminWriteRepository, {
    now: () => NOW,
  });
  return { service, repo, inserted };
}

const live = (existing: AdminAuditRow | null = null): World => ({
  admin: { role: 'OWNER', isActive: true },
  sessionOpen: true,
  existing,
});

describe('AdminWriteVoidService', () => {
  it('writes the tombstone: VOIDED, no key and no request hash in it', async () => {
    const { service, inserted } = harness(live());
    const answer = await service.void(principal(), '203.0.113.7', BODY);
    expect(answer).toEqual({ status: 'VOIDED', auditId: AUDIT_ID, at: NOW.toISOString() });
    expect(inserted).toEqual([
      {
        id: AUDIT_ID,
        actorId: ADMIN_ID,
        action: 'IDEMPOTENCY_VOID',
        targetType: 'User',
        targetId: BODY.targetId,
        after: { voidedAction: 'users.adjustWallet', adminRole: 'OWNER', sessionId: SESSION_ID },
        ip: '203.0.113.7',
      },
    ]);
    expect(JSON.stringify(inserted)).not.toContain(BODY.idempotencyKey);
    expect(JSON.stringify(inserted)).not.toContain('requestHash');
  });

  it('a key whose action committed is APPLIED with that row, nothing written', async () => {
    const { service, inserted } = harness(live(row('WALLET_ADJUST')));
    const answer = await service.void(principal(), null, BODY);
    expect(answer).toEqual({
      status: 'APPLIED',
      auditId: AUDIT_ID,
      action: 'WALLET_ADJUST',
      at: NOW.toISOString(),
    });
    expect(inserted).toEqual([]);
  });

  it('a key voided before is VOIDED again with the first tombstone', async () => {
    const { service, inserted } = harness(live(row('IDEMPOTENCY_VOID')));
    await expect(service.void(principal(), null, BODY)).resolves.toMatchObject({
      status: 'VOIDED',
      auditId: AUDIT_ID,
    });
    expect(inserted).toEqual([]);
  });

  it.each([
    ['an inactive admin', { admin: { role: 'OWNER', isActive: false } }],
    ['an unknown admin', { admin: null }],
    ['a closed session', { sessionOpen: false }],
    ['a role without the permission', { admin: { role: 'NOBODY', isActive: true } }],
    // SA-9B1-3: the role read in the tx may not perform the voided action.
    ['SUPPORT voiding an adjustment', { admin: { role: 'SUPPORT', isActive: true } }],
    ['OPERATOR voiding an adjustment', { admin: { role: 'OPERATOR', isActive: true } }],
  ])('%s: 404 before any write', async (_name, change) => {
    const { service, repo } = harness({ ...live(), ...change });
    const refused = service.void(principal(), null, BODY);
    await expect(refused).rejects.toBeInstanceOf(AppError);
    await expect(refused).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(repo.insertTombstone).not.toHaveBeenCalled();
  });

  it('SUPPORT voids a key of an action its role holds (a note)', async () => {
    const support: World = { ...live(), admin: { role: 'SUPPORT', isActive: true } };
    const { service, inserted } = harness(support);
    const answer = await service.void(principal('SUPPORT'), null, {
      ...BODY,
      action: 'users.note',
    });
    expect(answer).toMatchObject({ status: 'VOIDED', auditId: AUDIT_ID });
    expect(inserted).toHaveLength(1);
  });

  it('a row of another actor under the id is a 500, never an answer', async () => {
    const { service } = harness(live(row('WALLET_ADJUST', { actorType: 'CLI', actorId: null })));
    await expect(service.void(principal(), null, BODY)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });
});

describe('AdminWriteRunner and a tombstone', () => {
  const spec = (replay: jest.Mock) => ({
    principal: principal('OWNER'),
    ip: null,
    permission: 'users.adjustWallet' as const,
    targetId: BODY.targetId,
    key: BODY.idempotencyKey,
    body: { amountTiyin: '-500', reason: 'a reason long enough' },
    replay,
  });
  // Even a tombstone that carried this very request's hash is refused: the branch is explicit.
  const tombstoneLike = (requestHash: string) =>
    row('IDEMPOTENCY_VOID', { after: { requestHash, adminRole: 'OWNER' } });

  it('answers 409 from the tombstone before the work, never the replay', async () => {
    const s = spec(jest.fn());
    const hash = adminRequestHash(s.permission, s.targetId, s.body);
    const repo = { findAudit: jest.fn(() => Promise.resolve(tombstoneLike(hash))) };
    const runner = new AdminWriteRunner(
      repo as unknown as AdminWriteRepository,
      {} as AdminOtpVerifier,
    );
    const work = jest.fn((_actor: AdminActor) => Promise.resolve({ applied: true }));
    await expect(runner.run(s, work)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(work).not.toHaveBeenCalled();
    expect(s.replay).not.toHaveBeenCalled();
  });

  it('a work that lost its primary key to a tombstone ends in 409, not its own error', async () => {
    const s = spec(jest.fn());
    const hash = adminRequestHash(s.permission, s.targetId, s.body);
    const found = [null, tombstoneLike(hash)];
    const repo = { findAudit: jest.fn(() => Promise.resolve(found.shift() ?? null)) };
    const runner = new AdminWriteRunner(
      repo as unknown as AdminWriteRepository,
      {} as AdminOtpVerifier,
    );
    const work = jest.fn(() => Promise.reject(new Error('P2002 on AuditLog_pkey')));
    await expect(runner.run(s, work)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(s.replay).not.toHaveBeenCalled();
  });
});
