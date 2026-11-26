import { MANUAL_FX_SOURCE } from '@repo/shared';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { APP_CONFIG } from '../../config/config.module';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { FxAdminRepository } from '../../modules/fx-admin/fx-admin.repository';
import { NotifySourcesRepository } from '../../modules/notifications/notify-sources.repository';
import { OwnerAlertRenderer } from '../../modules/notifications/owner-alert.renderer';
import { ACTOR, useOpsE2e } from './ops-e2e.harness';

// fx:set on the real database (phase 5 S10 + fix round item 4, D-35, D-56): bounds refuse
// outright; one manual rate per pair per minute; no manual rate in 24 h, or a move of more than 10%
// from ANY manual rate of 24 h (the window's extremes, no row cap), needs the re-typed rate and the
// owner's code; the row, the derived TON_UZS (rounded up) and the AuditLog are written together or
// not at all. Only this file writes `manual` rows: they are removed around every test so other
// suites never price from them.

// Declared before the harness: jest runs afterAll hooks in declaration order, and the rows must
// go while the harness's database client is still open (after it, a query would reopen a pool).
afterAll(() => removeManualRows());
const t = useOpsE2e();
const WHO = ['--reason', 'exchange rate from the bank board', '--operator', ACTOR.operator];
const written = new Set<string>();
const MIN = 60_000;

async function removeManualRows(): Promise<void> {
  const manual = await t.db().fxRate.findMany({
    where: { OR: [{ source: MANUAL_FX_SOURCE }, { id: { in: [...written] } }] },
    select: { id: true },
  });
  const ids = manual.map((r) => r.id);
  // Derived rows name their parents in the source: drop the ones built on a manual row.
  for (const id of ids) {
    await t.db().fxRate.deleteMany({ where: { pair: 'TON_UZS', source: { contains: id } } });
  }
  await t.db().fxRate.deleteMany({ where: { id: { in: ids } } });
}

beforeEach(removeManualRows);

/** An owner's row typed `agoMs` before `nowMs` (the history a test needs, without waiting). */
async function seed(
  pair: string,
  rate: string,
  agoMs: number,
  nowMs = Date.now(),
): Promise<string> {
  const row = await t.db().fxRate.create({
    data: { pair, rate, source: MANUAL_FX_SOURCE, createdAt: new Date(nowMs - agoMs) },
  });
  written.add(row.id);
  return row.id;
}

function fields(out: readonly string[]): Record<string, string> {
  const all: Record<string, string> = {};
  for (const line of out) {
    const at = line.indexOf('=');
    if (at > 0) all[line.slice(0, at)] = line.slice(at + 1);
  }
  return all;
}

const set = (pair: string, rate: string) => ['fx:set', '--pair', pair, '--rate', rate, ...WHO];
/** The API's owner-alert renderer over the real sources (the CLI graph has no notify module). */
function ownerAlerts(): OwnerAlertRenderer {
  const app = t.app();
  const sources = new NotifySourcesRepository(app.get(PrismaService), app.get(RedisService));
  return new OwnerAlertRenderer(sources, app.get(APP_CONFIG), app.get(CLOCK));
}

/**
 * S9i F-1: `previous` (and a derivation's other pair) is the newest row of the pair from ANY source
 * (fx-admin.plan.ts `latest`), and other suites leave rows (worker fulfill-e2e: USDT_UZS 30000.5).
 * A test whose seed must be the newest runs the CLI on the app CLOCK moved `agoMs` past them.
 */
async function clockAfterOthers(
  pair: string,
  agoMs: number,
): Promise<{
  readonly nowMs: number;
  readonly restore: () => void;
}> {
  const newest = await t.db().fxRate.findFirst({
    where: { pair },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { createdAt: true },
  });
  const nowMs = Math.max(Date.now(), (newest?.createdAt.getTime() ?? 0) + 1 + agoMs);
  const spy = jest.spyOn(t.app().get<Clock>(CLOCK), 'now').mockReturnValue(new Date(nowMs));
  return { nowMs, restore: () => spy.mockRestore() };
}

const manualCount = () => t.db().fxRate.count({ where: { source: MANUAL_FX_SOURCE } });

describe('fx:set (real Postgres)', () => {
  it('refuses a rate outside the bounds and a pair that is not set by hand; nothing is written', async () => {
    for (const argv of [
      set('USDT_UZS', '5000'),
      set('TON_USDT', '500'),
      set('TON_UZS', '40000'),
      set('USDT_UZS', '1e4'),
    ]) {
      const refused = await t.run(argv);
      expect(refused.code).toBe(1);
      expect(refused.asked).toEqual([]);
    }
    expect((await t.run(set('USDT_UZS', '5000'))).err.join('\n')).toContain('OUT_OF_BOUNDS');
    expect(await manualCount()).toBe(0);
  });

  it('the first rate (none in 24 h) needs the code; a second one within a minute is refused', async () => {
    const wrongRetype = await t.run(set('USDT_UZS', '12800'), ['12900']);
    expect(wrongRetype.code).toBe(1);
    expect(wrongRetype.asked).toHaveLength(1); // no code was sent for a wrong re-typed rate
    expect(await manualCount()).toBe(0);

    const first = await t.run(set('USDT_UZS', '12800'), ['12800', t.codeFor('fx USDT_UZS 12800')]);
    expect(first.err).toEqual([]);
    expect(first.code).toBe(0);
    const firstOut = fields(first.out);
    expect(firstOut['confirms']).toContain('USDT_UZS: no manual rate in 24 h');
    expect(firstOut).toMatchObject({ applied: 'true', otpVerified: 'true', derived: '-' });
    written.add(firstOut['fxRate'] ?? '');
    const audit = await t.audit(firstOut['audit'] ?? '');
    expect(audit).toMatchObject({ action: 'FX_SET', actorType: 'CLI', targetType: 'FxRate' });
    expect(audit.targetId).toBe(firstOut['fxRate']);
    const row = await t.db().fxRate.findUniqueOrThrow({ where: { id: firstOut['fxRate'] ?? '' } });
    expect(row).toMatchObject({ pair: 'USDT_UZS', source: MANUAL_FX_SOURCE, rate: '12800' });

    // Audit L-1: one manual rate per pair per minute, refused before anything is asked.
    const tooSoon = await t.run(set('USDT_UZS', '12810'));
    expect(tooSoon.code).toBe(1);
    expect(tooSoon.asked).toEqual([]);
    expect(tooSoon.err.join('\n')).toContain('TOO_SOON');
    expect(await manualCount()).toBe(1);
  });

  it('a small move needs no code; a jump over 10% does', async () => {
    const clock = await clockAfterOthers('USDT_UZS', 2 * MIN);
    let small: Awaited<ReturnType<typeof t.run>>;
    try {
      await seed('USDT_UZS', '12800', 2 * MIN, clock.nowMs);
      small = await t.run(set('USDT_UZS', '13000'));
    } finally {
      clock.restore();
    }
    expect(small.err).toEqual([]);
    expect(small.code).toBe(0);
    expect(small.asked).toEqual([]);
    expect(fields(small.out)).toMatchObject({ confirms: '-', otpVerified: 'false' });
    written.add(fields(small.out)['fxRate'] ?? '');
    // Re-review N2: the owner's alert reads this audit row's before/after from the database.
    const alert = await ownerAlerts().render('adminAction', fields(small.out)['audit'] ?? '');
    expect(alert).toContain('FX_SET USDT_UZS: 12800 → 13000 (157 bps)');

    await removeManualRows();
    await seed('USDT_UZS', '12800', 2 * MIN);
    const jump = await t.run(set('USDT_UZS', '15000'), ['15000', '']);
    expect(jump.code).toBe(1);
    expect(fields(jump.out)['confirms']).toMatch(/USDT_UZS: \d+ bps from /);
    expect(await manualCount()).toBe(1);
  });

  it('cumulative 24 h: 12800 -> 13900 -> 14100 needs the code (10.16% from the first, 1.4% from the last)', async () => {
    const firstId = await seed('USDT_UZS', '12800', 20 * MIN);
    await seed('USDT_UZS', '13900', 10 * MIN);
    const out = await t.run(set('USDT_UZS', '14100'), ['14100', '']);
    expect(out.code).toBe(1);
    expect(fields(out.out)['confirms']).toBe(`USDT_UZS: 1016 bps from ${firstId}`);
    expect(await manualCount()).toBe(2);
  });

  it('audit L-1: hundreds of later rows do not push the oldest reference of the window out', async () => {
    const oldestId = await seed('USDT_UZS', '12800', 23 * 60 * MIN);
    const at = Date.now() - 5 * MIN;
    await t.db().fxRate.createMany({
      data: Array.from({ length: 600 }, (_, i) => ({
        pair: 'USDT_UZS',
        rate: '13900',
        source: MANUAL_FX_SOURCE,
        createdAt: new Date(at - i * 1000),
      })),
    });
    const out = await t.run(set('USDT_UZS', '14100'), ['14100', '']);
    expect(out.code).toBe(1);
    expect(fields(out.out)['confirms']).toBe(`USDT_UZS: 1016 bps from ${oldestId}`);
  });

  it('the history moved after the code was sent: OTP_MISMATCH inside the transaction, nothing written', async () => {
    const repo = t.app().get(FxAdminRepository);
    const lock = repo.lockFxSet.bind(repo);
    // A manual row lands after set() planned and verified the code, before the locked re-plan.
    const spy = jest.spyOn(repo, 'lockFxSet').mockImplementationOnce(async (tx) => {
      await seed('USDT_UZS', '12700', 2 * MIN);
      await lock(tx);
    });
    try {
      const out = await t.run(set('USDT_UZS', '12800'), ['12800', t.codeFor('fx USDT_UZS 12800')]);
      expect(out.code).toBe(1);
      expect(out.err.join('\n')).toContain('OTP_MISMATCH');
    } finally {
      spy.mockRestore();
    }
    expect(await t.db().fxRate.count({ where: { source: MANUAL_FX_SOURCE, rate: '12800' } })).toBe(
      0,
    );
  });

  it('re-review N1: two runs both past the preview meet at the lock; one writes, one TOO_SOON', async () => {
    await seed('USDT_UZS', '12800', 2 * MIN);
    const repo = t.app().get(FxAdminRepository);
    const lock = repo.lockFxSet.bind(repo);
    // Both runs have planned (no row within a minute yet) before either takes the lock, so only
    // the locked re-plan can see the other's row. With a no-op lock both would write.
    let arrived = 0;
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = jest.spyOn(repo, 'lockFxSet').mockImplementation(async (tx) => {
      arrived += 1;
      if (arrived === 2) release();
      await barrier;
      await lock(tx);
    });
    try {
      const runs = await Promise.all([
        t.run(set('USDT_UZS', '13000')),
        t.run(set('USDT_UZS', '13010')),
      ]);
      expect(arrived).toBe(2);
      expect(runs.map((r) => r.code).sort()).toEqual([0, 1]);
      expect(runs.find((r) => r.code === 1)?.err.join('\n')).toContain('TOO_SOON');
      for (const r of runs) written.add(fields(r.out)['fxRate'] ?? '');
    } finally {
      spy.mockRestore();
    }
    expect(await manualCount()).toBe(2);
  });

  it('CR m2: when the audit row cannot be written no rate is written either', async () => {
    await seed('USDT_UZS', '12800', 2 * MIN);
    const repo = t.app().get(FxAdminRepository);
    const spy = jest
      .spyOn(repo, 'createAudit')
      .mockRejectedValueOnce(new Error('audit insert refused'));
    try {
      const out = await t.run(set('USDT_UZS', '13000'));
      expect(out.code).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(await manualCount()).toBe(1);
  });

  it('TON_USDT with a fresh manual USDT_UZS derives TON_UZS in the same transaction, rounded UP', async () => {
    // 3.000000000000000001 x 12800.5 = 38401.5000000000000128005: 19 decimals, cut to 18 upwards
    // (rules/40: a rate used for cost rounds up), never down to ...0128.
    const clock = await clockAfterOthers('USDT_UZS', 0);
    const rate = '3.000000000000000001';
    let out: Awaited<ReturnType<typeof t.run>>;
    try {
      await seed('USDT_UZS', '12800.5', 0, clock.nowMs);
      out = await t.run(set('TON_USDT', rate), [rate, t.codeFor(`fx TON_USDT ${rate}`)]);
    } finally {
      clock.restore();
    }
    expect(out.err).toEqual([]);
    expect(out.code).toBe(0);
    const done = fields(out.out);
    expect(done['derivedTonUzs']).toBe('38401.500000000000012801');
    expect(done['confirms']).toContain('TON_UZS: no manual rate in 24 h');
    written.add(done['fxRate'] ?? '');
    const derivedId = (done['derived'] ?? '').split(' ')[0] ?? '';
    written.add(derivedId);
    const derived = await t.db().fxRate.findUniqueOrThrow({ where: { id: derivedId } });
    expect(derived).toMatchObject({ pair: 'TON_UZS', rate: '38401.500000000000012801' });
    expect(derived.source).toContain(done['fxRate']);
    const audit = await t.audit(done['audit'] ?? '');
    expect(JSON.stringify(audit.after)).toContain(derivedId);
  });

  it('a USDT_UZS rate 31 minutes old derives nothing', async () => {
    await seed('USDT_UZS', '12800', 31 * MIN);
    const out = await t.run(set('TON_USDT', '3.1'), ['3.1', t.codeFor('fx TON_USDT 3.1')]);
    expect(out.code).toBe(0);
    const done = fields(out.out);
    written.add(done['fxRate'] ?? '');
    expect(done['derived']).toBe('-');
    expect(done['derivedSkipped']).not.toBe('-');
    expect(
      await t.db().fxRate.count({
        where: { pair: 'TON_UZS', source: { contains: done['fxRate'] ?? 'none' } },
      }),
    ).toBe(0);
  });
});
