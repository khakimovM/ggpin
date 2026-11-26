import { FX_MAX_AGE_MS, MANUAL_FX_MIN_INTERVAL_MS, MANUAL_FX_SOURCE } from '@repo/shared';
import type { Db } from '../../../infra/prisma/db';
import { jumpFlag, planFx } from '../fx-admin.plan';
import type { FxAdminRepository, FxRow } from '../fx-admin.repository';

// planFx without a database (phase 5 S10 fix round, item 4): the per-pair interval, the cumulative
// 24 h rule against the window's extremes, and the age of the other pair's rate for TON_UZS.

const NOW = new Date('2026-11-15T10:00:00.000Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const MIN = 60_000;

const row = (id: string, pair: string, rate: string, createdAt: Date, source = MANUAL_FX_SOURCE) =>
  ({ id, pair, rate, source, createdAt }) satisfies FxRow;

function repoWith(options: {
  recent?: boolean;
  extremes?: FxRow[];
  other?: FxRow | null;
  derived?: FxRow[];
}) {
  const repo = {
    manualSetAfter: jest.fn().mockResolvedValue(options.recent ?? false),
    manualExtremes: jest.fn().mockResolvedValue(options.extremes ?? []),
    manualDerivedExtremes: jest.fn().mockResolvedValue(options.derived ?? []),
    latest: jest.fn((_db: Db, pair: string) =>
      Promise.resolve(pair === 'USDT_UZS' ? (options.other ?? null) : null),
    ),
  };
  return { repo, asRepo: repo as unknown as FxAdminRepository };
}

const db = {} as Db;

describe('planFx', () => {
  it('refuses a second manual rate of the pair within the interval (audit L-1), before reading history', async () => {
    const { repo, asRepo } = repoWith({ recent: true });
    await expect(
      planFx(asRepo, db, { pair: 'USDT_UZS', rate: '12800', now: NOW }),
    ).rejects.toMatchObject({ details: { field: 'rate', reason: 'TOO_SOON' } });
    expect(repo.manualSetAfter).toHaveBeenCalledWith(
      db,
      'USDT_UZS',
      ago(MANUAL_FX_MIN_INTERVAL_MS),
    );
    expect(repo.manualExtremes).not.toHaveBeenCalled();
  });

  it('cumulative 24 h rule: 12800 -> 13900 -> 14100 is 1.4% from the last but 10.16% from the first', async () => {
    // The repository hands over the window's highest and lowest rate (highest first).
    const first = row('fx-first', 'USDT_UZS', '12800', ago(20 * MIN));
    const last = row('fx-last', 'USDT_UZS', '13900', ago(10 * MIN));
    const { asRepo } = repoWith({ extremes: [last, first] });
    const plan = await planFx(asRepo, db, { pair: 'USDT_UZS', rate: '14100', now: NOW });
    expect(plan.flags).toBe('USDT_UZS: 1016 bps from fx-first');
    expect(jumpFlag('USDT_UZS', '14100', [last])).toBeNull();
  });

  it('TON_UZS is derived only from a manual USDT_UZS rate at most FX_MAX_AGE_MS old', async () => {
    const stale = repoWith({
      other: row('fx-u', 'USDT_UZS', '12800', ago(FX_MAX_AGE_MS + MIN)),
    });
    const skipped = await planFx(stale.asRepo, db, { pair: 'TON_USDT', rate: '3.1', now: NOW });
    expect(skipped.derived).toBeNull();
    expect(skipped.derivedSkip).toBe('the newest USDT_UZS rate is stale');
    expect(stale.repo.manualDerivedExtremes).not.toHaveBeenCalled();

    const fresh = repoWith({ other: row('fx-u', 'USDT_UZS', '12800', ago(FX_MAX_AGE_MS)) });
    const derived = await planFx(fresh.asRepo, db, { pair: 'TON_USDT', rate: '3.1', now: NOW });
    expect(derived.derived?.rate).toBe('39680');
    expect(derived.derivedSkip).toBeNull();

    const simulated = repoWith({
      other: row('fx-s', 'USDT_UZS', '12800', ago(MIN), 'simulator'),
    });
    const notManual = await planFx(simulated.asRepo, db, {
      pair: 'TON_USDT',
      rate: '3.1',
      now: NOW,
    });
    expect(notManual.derivedSkip).toBe('the newest USDT_UZS rate is not a manual one');
  });
});
