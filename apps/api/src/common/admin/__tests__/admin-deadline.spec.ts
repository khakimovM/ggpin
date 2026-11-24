import { ERROR_HTTP_STATUS } from '@repo/shared';
import type { Db } from '../../../infra/prisma/db';
import { AppError } from '../../exceptions/app-error';
import { ADMIN_WRITE_DEADLINE_MS, assertWithinDeadline } from '../admin-deadline';
import { runActorTransaction } from '../admin-transaction';
import type { AdminActor, CheckedAuditActor } from '../audit-actor';
import { confirmActorInTx } from '../audit-actor.check';
import { FakeMonotonicClock } from './admin-deadline.fixture';

// docs/04 «So‘rov deadline’i» (9-B M-1, Q3): 45 s from the onRequest stamp, on an injected
// monotonic clock (never the wall clock). Points 2 and 3 here; point 1 in the runner's spec.
const RECEIVED = 1_000;
const NOW = new Date('2026-11-24T10:00:00.000Z');

function adminAt(elapsedMs: number): { actor: AdminActor; clock: FakeMonotonicClock } {
  const clock = new FakeMonotonicClock(RECEIVED + elapsedMs);
  const actor: AdminActor = {
    kind: 'ADMIN',
    adminId: 'cmadmin0deadline0unit00001',
    sessionId: 'cmsession0deadline0unit001',
    ip: null,
    permission: 'users.block',
    request: { auditId: `a${'0'.repeat(31)}`, requestHash: 'h'.repeat(64) },
    deadline: { receivedAtMs: RECEIVED, clock },
  };
  return { actor, clock };
}

const cli: CheckedAuditActor = { kind: 'CLI', operator: 'aziz', ip: null, osUser: null };

/** A tx whose reads find the admin active as OWNER with an open session; it counts its calls. */
function liveTx() {
  const calls: string[] = [];
  const tx = {
    $queryRaw: () => {
      calls.push('lockAdmin');
      return Promise.resolve([{ id: 'x', role: 'OWNER', isActive: true }]);
    },
    adminSession: {
      findUnique: () => {
        calls.push('session');
        return Promise.resolve({
          adminId: 'cmadmin0deadline0unit00001',
          revokedAt: null,
          expiresAt: new Date(NOW.getTime() + 3_600_000),
        });
      },
    },
  } as unknown as Db;
  return { tx, calls };
}

/** A repository transaction that records whether its callback threw (a rollback) or returned. */
function fakeRepo() {
  const outcomes: string[] = [];
  const tx = {} as Db;
  return {
    outcomes,
    repo: {
      async transaction<R>(fn: (db: Db) => Promise<R>): Promise<R> {
        try {
          const result = await fn(tx);
          outcomes.push('commit');
          return result;
        } catch (error) {
          outcomes.push('rollback');
          throw error;
        }
      },
    },
  };
}

describe('assertWithinDeadline', () => {
  it('is 45 s, a server constant, and its refusal is a 503', () => {
    expect(ADMIN_WRITE_DEADLINE_MS).toBe(45_000);
    expect(ERROR_HTTP_STATUS.ADMIN_DEADLINE_EXCEEDED).toBe(503);
  });

  it.each([0, 44_999, 45_000])('%i ms after the stamp passes', (elapsed) => {
    expect(() => assertWithinDeadline(adminAt(elapsed).actor.deadline)).not.toThrow();
  });

  it.each([45_001, 46_000, 10 * 60_000])('%i ms after the stamp is refused', (elapsed) => {
    const refused = thrown(() => assertWithinDeadline(adminAt(elapsed).actor.deadline));
    expect(refused).toBeInstanceOf(AppError);
    expect(refused).toMatchObject({ code: 'ADMIN_DEADLINE_EXCEEDED' });
  });

  it('a stamp that is not a number refuses (fail closed, never "no deadline")', () => {
    const clock = new FakeMonotonicClock(RECEIVED);
    const refused = thrown(() => assertWithinDeadline({ receivedAtMs: Number.NaN, clock }));
    expect(refused).toMatchObject({ code: 'ADMIN_DEADLINE_EXCEEDED' });
  });
});

function thrown(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return 'nothing thrown';
}

/** confirmActorInTx as the services call it: inside a transaction runActorTransaction opened. */
function confirmInActorTx(tx: Db, actor: CheckedAuditActor) {
  const repo = { transaction: <R>(fn: (db: Db) => Promise<R>) => fn(tx) };
  return runActorTransaction(repo, actor, (db) => confirmActorInTx(db, actor, NOW));
}

describe('point 2: confirmActorInTx', () => {
  it('past the deadline: refused before the admin row is read or locked', async () => {
    const { tx, calls } = liveTx();
    await expect(confirmInActorTx(tx, adminAt(45_001).actor)).rejects.toMatchObject({
      code: 'ADMIN_DEADLINE_EXCEEDED',
    });
    expect(calls).toEqual([]);
  });

  it('within it: the admin is re-read as before', async () => {
    const { tx, calls } = liveTx();
    await expect(confirmInActorTx(tx, adminAt(44_999).actor)).resolves.toMatchObject({
      adminRole: 'OWNER',
    });
    expect(calls).toEqual(['lockAdmin', 'session']);
  });

  it('the owner CLI has no deadline at all', async () => {
    const { tx } = liveTx();
    await expect(confirmInActorTx(tx, cli)).resolves.toEqual({ operator: 'aziz', osUser: null });
  });
});

describe('confirmActorInTx outside runActorTransaction (CR-1, SA L-1)', () => {
  it('an admin actor in a transaction the helper did not open: 500, nothing read', async () => {
    const { tx, calls } = liveTx();
    const refused = confirmActorInTx(tx, adminAt(0).actor, NOW);
    await expect(refused).rejects.toBeInstanceOf(AppError);
    await expect(refused).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(calls).toEqual([]);
  });

  it('the owner CLI is not checked: its services open their own transactions', async () => {
    const { tx } = liveTx();
    await expect(confirmActorInTx(tx, cli, NOW)).resolves.toEqual({
      operator: 'aziz',
      osUser: null,
    });
  });
});

describe('point 3: runActorTransaction, before the commit', () => {
  it('the deadline passing during the work rolls the whole transaction back: 503', async () => {
    const { actor, clock } = adminAt(0);
    const { repo, outcomes } = fakeRepo();
    const work = jest.fn(() => {
      clock.ms = RECEIVED + 45_001; // the ledger row is written, then the time runs out
      return Promise.resolve('written');
    });
    await expect(runActorTransaction(repo, actor, work)).rejects.toMatchObject({
      code: 'ADMIN_DEADLINE_EXCEEDED',
    });
    expect(work).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual(['rollback']);
  });

  it('exactly at the deadline it still commits', async () => {
    const { actor, clock } = adminAt(0);
    const { repo, outcomes } = fakeRepo();
    const result = await runActorTransaction(repo, actor, () => {
      clock.ms = RECEIVED + 45_000;
      return Promise.resolve('written');
    });
    expect(result).toBe('written');
    expect(outcomes).toEqual(['commit']);
  });

  it('the owner CLI commits whatever the clock says', async () => {
    const { repo, outcomes } = fakeRepo();
    await expect(runActorTransaction(repo, cli, () => Promise.resolve(7))).resolves.toBe(7);
    expect(outcomes).toEqual(['commit']);
  });

  it('a refusal of the work itself passes through unchanged', async () => {
    const { actor } = adminAt(0);
    const { repo, outcomes } = fakeRepo();
    const own = new AppError('NOT_FOUND');
    await expect(runActorTransaction(repo, actor, () => Promise.reject(own))).rejects.toBe(own);
    expect(outcomes).toEqual(['rollback']);
  });
});
