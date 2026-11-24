import type { AdminUser } from '@repo/db';
import type { AdminWriteKeyVoidBody } from '@repo/shared';
import { FakeMonotonicClock } from '../../../../common/admin/__tests__/admin-deadline.fixture';
import type { AdminActor } from '../../../../common/admin/audit-actor';
import { AppError } from '../../../../common/exceptions/app-error';
import type { Db } from '../../../../infra/prisma/db';
import type { AdminPrincipal } from '../../common/admin-request';
import type { AdminOtpVerifier } from '../../confirm/admin-otp.verifier';
import { adminAuditIdFor, adminRequestHash } from '../admin-write-key';
import { AdminWriteVoidService } from '../admin-write-void.service';
import type { AdminAuditRow, AdminWriteRepository } from '../admin-write.repository';
import { AdminWriteRunner } from '../admin-write.runner';

// docs/04 «So‘rov deadline’i», point 1: the runner checks the deadline AFTER the replay lookup
// (a committed key always gets its answer) and before the work; the void path checks it before
// its transaction. The clock is injected (never the wall clock).
const RECEIVED = 5_000;
const ADMIN_ID = 'cmadmin0deadline0runner001';
const KEY = 'deadline-unit-key-01';
const AUDIT_ID = adminAuditIdFor(ADMIN_ID, KEY);
const NOW = new Date('2026-11-24T10:00:00.000Z');

const principal = (role: AdminUser['role'] = 'OWNER'): AdminPrincipal =>
  ({ sessionId: 'cmsession0deadline0runner1', admin: { id: ADMIN_ID, role } }) as AdminPrincipal;

const spec = (replay: jest.Mock) => ({
  principal: principal(),
  ip: null,
  receivedAtMs: RECEIVED,
  permission: 'users.adjustWallet' as const,
  targetId: 'cmuser0deadline0runner0001',
  key: KEY,
  body: { amountTiyin: '-500', reason: 'a reason long enough' },
  replay,
});

function runnerAt(elapsedMs: number, earlier: AdminAuditRow | null) {
  const repo = { findAudit: jest.fn(() => Promise.resolve(earlier)) };
  const clock = new FakeMonotonicClock(RECEIVED + elapsedMs);
  const runner = new AdminWriteRunner(
    repo as unknown as AdminWriteRepository,
    {} as AdminOtpVerifier,
    clock,
  );
  return { runner, repo, clock };
}

describe('AdminWriteRunner: point 1 of the request deadline', () => {
  it('past the deadline: 503 before the work, nothing written, after the replay lookup', async () => {
    const s = spec(jest.fn());
    const { runner, repo } = runnerAt(45_001, null);
    const work = jest.fn((_actor: AdminActor) => Promise.resolve({ applied: true }));
    await expect(runner.run(s, work)).rejects.toMatchObject({ code: 'ADMIN_DEADLINE_EXCEEDED' });
    expect(repo.findAudit).toHaveBeenCalledTimes(1);
    expect(work).not.toHaveBeenCalled();
  });

  it('within it: the work runs with the deadline on its actor', async () => {
    const s = spec(jest.fn());
    const { runner, clock } = runnerAt(44_999, null);
    const work = jest.fn((_actor: AdminActor) => Promise.resolve({ applied: true }));
    await expect(runner.run(s, work)).resolves.toEqual({ applied: true });
    expect(work).toHaveBeenCalledWith(
      expect.objectContaining({ deadline: { receivedAtMs: RECEIVED, clock } }),
    );
  });

  it('a key whose work committed gets its replay whatever the clock says', async () => {
    const s = spec(jest.fn(() => Promise.resolve({ applied: false, auditId: AUDIT_ID })));
    const hash = adminRequestHash(s.permission, s.targetId, s.body);
    const committed: AdminAuditRow = {
      id: AUDIT_ID,
      actorType: 'ADMIN',
      actorId: ADMIN_ID,
      action: 'WALLET_ADJUST',
      targetId: s.targetId,
      after: { requestHash: hash },
      createdAt: NOW,
    };
    const { runner } = runnerAt(10 * 60_000, committed);
    const work = jest.fn();
    await expect(runner.run(s, work)).resolves.toEqual({ applied: false, auditId: AUDIT_ID });
    expect(s.replay).toHaveBeenCalledWith(committed);
    expect(work).not.toHaveBeenCalled();
  });

  it('a deadline refusal inside the work with no twin row stays a 503', async () => {
    const s = spec(jest.fn());
    const { runner, repo } = runnerAt(0, null);
    const work = jest.fn(() => Promise.reject(new AppError('ADMIN_DEADLINE_EXCEEDED')));
    await expect(runner.run(s, work)).rejects.toMatchObject({ code: 'ADMIN_DEADLINE_EXCEEDED' });
    expect(repo.findAudit).toHaveBeenCalledTimes(2); // the lookup, then the twin re-check
    expect(s.replay).not.toHaveBeenCalled();
  });
});

describe('AdminWriteVoidService: the request deadline', () => {
  const body: AdminWriteKeyVoidBody = {
    idempotencyKey: KEY,
    action: 'users.adjustWallet',
    targetId: 'cmuser0deadline0runner0001',
  };

  it('past the deadline: 503 before its transaction, no tombstone', async () => {
    const repo = { transaction: jest.fn(), insertTombstone: jest.fn(), findAudit: jest.fn() };
    const voids = new AdminWriteVoidService(
      repo as unknown as AdminWriteRepository,
      { now: () => NOW },
      new FakeMonotonicClock(RECEIVED + 45_001),
    );
    await expect(voids.void(principal(), null, body, RECEIVED)).rejects.toMatchObject({
      code: 'ADMIN_DEADLINE_EXCEEDED',
    });
    expect(repo.transaction).not.toHaveBeenCalled();
    expect(repo.insertTombstone).not.toHaveBeenCalled();
  });
});

describe('AdminWriteRunner: the deadline before the step-up code is used (CR-5)', () => {
  const otp = { challengeId: 'c'.repeat(32), code: '123456' };
  const withCode = (replay: jest.Mock) => ({
    ...spec(replay),
    otp,
    confirmation: () => ({
      action: 'users.adjustWallet',
      targetId: 'cmuser0deadline0runner0001',
      amountTiyin: '-500',
      idempotencyKey: KEY,
    }),
  });

  function codeRunner() {
    const repo = { findAudit: jest.fn(() => Promise.resolve(null)) };
    const verifier = { verify: jest.fn(() => Promise.resolve()) };
    const clock = new FakeMonotonicClock(RECEIVED);
    const runner = new AdminWriteRunner(
      repo as unknown as AdminWriteRepository,
      verifier as unknown as AdminOtpVerifier,
      clock,
    );
    return { runner, verifier, clock };
  }

  it('past the deadline when the service checks the code: 503 and the code is not used', async () => {
    const { runner, verifier, clock } = codeRunner();
    const work = jest.fn(async (actor: AdminActor) => {
      clock.ms = RECEIVED + 45_001; // the service's reads before the code took too long
      await actor.stepUp?.verify([]);
      return { applied: true };
    });
    await expect(runner.run(withCode(jest.fn()), work)).rejects.toMatchObject({
      code: 'ADMIN_DEADLINE_EXCEEDED',
    });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('within it the code is checked as before', async () => {
    const { runner, verifier } = codeRunner();
    const work = jest.fn(async (actor: AdminActor) => {
      await actor.stepUp?.verify([]);
      return { applied: true };
    });
    await expect(runner.run(withCode(jest.fn()), work)).resolves.toEqual({ applied: true });
    expect(verifier.verify).toHaveBeenCalledTimes(1);
  });
});

describe('AdminWriteVoidService: the deadline before the commit (CR-2, SA L-2)', () => {
  const body: AdminWriteKeyVoidBody = {
    idempotencyKey: KEY,
    action: 'users.adjustWallet',
    targetId: 'cmuser0deadline0runner0001',
  };

  it('the time runs out after the tombstone insert: the transaction rolls back, 503', async () => {
    const clock = new FakeMonotonicClock(RECEIVED);
    const outcomes: string[] = [];
    const tx = {
      $queryRaw: () => Promise.resolve([{ id: ADMIN_ID, role: 'OWNER', isActive: true }]),
      adminSession: {
        findUnique: () =>
          Promise.resolve({
            adminId: ADMIN_ID,
            revokedAt: null,
            expiresAt: new Date(NOW.getTime() + 3_600_000),
          }),
      },
    } as unknown as Db;
    const repo = {
      transaction: async <R>(fn: (db: Db) => Promise<R>): Promise<R> => {
        try {
          const result = await fn(tx);
          outcomes.push('commit');
          return result;
        } catch (error) {
          outcomes.push('rollback');
          throw error;
        }
      },
      insertTombstone: jest.fn(() => {
        clock.ms = RECEIVED + 45_001;
        return Promise.resolve(true);
      }),
      findAudit: jest.fn(() =>
        Promise.resolve({
          id: AUDIT_ID,
          actorType: 'ADMIN',
          actorId: ADMIN_ID,
          action: 'IDEMPOTENCY_VOID',
          targetId: body.targetId,
          after: {},
          createdAt: NOW,
        }),
      ),
    };
    const voids = new AdminWriteVoidService(
      repo as unknown as AdminWriteRepository,
      { now: () => NOW },
      clock,
    );
    await expect(voids.void(principal(), null, body, RECEIVED)).rejects.toMatchObject({
      code: 'ADMIN_DEADLINE_EXCEEDED',
    });
    expect(repo.insertTombstone).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual(['rollback']);
  });
});
