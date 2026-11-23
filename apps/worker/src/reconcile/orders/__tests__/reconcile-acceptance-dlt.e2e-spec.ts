import { setTimeout as sleep } from 'node:timers/promises';
import { Address, type Transaction } from '@ton/core';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import { payRequest, rowsOf, tonFactOf } from '../../../ton/__tests__/ton-e2e.fixtures';
import { TonOutcomeRepository, type TonOutcome } from '../../../ton/ton-outcome.repository';
import { bounceSentBack, ourTxFacts, returnTxOf } from '../../../ton/ton-tx-facts';
import { countsOf, useReconcileE2e, type Reconciler } from './reconcile-e2e.harness';

// DL-T (plan 717, R4-1, plan §S9i) on the real database: the BOUNCED classifier and the worker's
// DELIVERED write meet on ONE unresolved transfer, two real transactions through the real
// TonOutcomeRepository (order -> attempt -> transfer, 40P01 retried). A test trigger (pg_sleep on
// this transfer's UPDATE) holds the first writer inside its transaction while the second one
// queues behind it. The end is always exactly one of: BOUNCED + NEEDS_REVIEW, or DELIVERED (the
// late bounce then found by the tick's late step: the `lateBounce` facts + critical tonBounced).
// Never both, never neither (no "unknown outcome"). A deadlock forced by a transaction taking the
// locks in the guard's direction (transfer, then order FOR SHARE) is retried, not surfaced.

const r = useReconcileE2e();
const { t } = r;

interface Collision {
  readonly orderId: string;
  readonly userId: string;
  readonly attemptId: string;
  readonly transferId: string;
  readonly delivered: TonOutcome;
  readonly bounced: TonOutcome;
}

/** A repository of our own whose `$transaction` calls are counted (one per try). */
function countingRepository(db: PrismaService['client']) {
  const tries = { n: 0 };
  const client = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return (...args: Parameters<typeof target.$transaction>) => {
          tries.n += 1;
          return target.$transaction(...args);
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  return { repo: new TonOutcomeRepository({ client }), tries };
}

/** The worker died right after the broadcast; the payout landed and the destination bounced it. */
async function collision(rec: Reconciler): Promise<Collision> {
  const fixture = await r.order();
  const request = payRequest(fixture);
  const destination = Address.parseRaw(request.toAddress);
  t.gateway.destination(destination, 'BOUNCE');
  rec.hooks.afterBroadcastFn = () => Promise.reject(new Error('the worker died here'));
  await expect(rec.sender.pay(request)).rejects.toThrow('the worker died here');
  rec.hooks.afterBroadcastFn = () => Promise.resolve();
  const rows = await rowsOf(t.db, fixture);
  expect([rows.order.status, rows.transfer?.status]).toEqual(['PROCESSING', 'BROADCAST']);
  const ours = t.gateway
    .transactionsOf(t.wallet.address)
    .filter((tx: Transaction) => tx.inMessage?.info.type === 'external-in')
    .at(-1);
  const destTx = t.gateway.transactionsOf(destination).at(-1);
  if (ours === undefined || destTx === undefined) throw new Error('nothing on the chain');
  const bounce = bounceSentBack(destTx, t.wallet.address);
  if (bounce === null) throw new Error('no bounce');
  const returnTx = t.gateway
    .transactionsOf(t.wallet.address)
    .map((tx) => returnTxOf(tx, t.wallet.address, request.toAddress, bounce))
    .find((found) => found !== null);
  if (returnTx === undefined || returnTx === null) throw new Error('no return transaction');
  const tx = ourTxFacts(ours);
  return {
    orderId: fixture.orderId,
    userId: fixture.userId,
    attemptId: fixture.attemptId,
    transferId: rows.transfer?.id ?? '',
    delivered: { kind: 'CONFIRMED', tx },
    bounced: { kind: 'BOUNCED', tx, returnTx },
  };
}

/**
 * This test's own sessions only (S9i gate A3), never another client of the database:
 * `sleeping` — a session whose UPDATE of "TonTransfer" sleeps in the test trigger; `blocked` — a
 * session waiting for a lock held by such a sleeper, or (`blocker`) by that backend pid.
 */
async function sessionsWaiting(what: 'sleeping' | 'blocked', blocker?: number): Promise<number> {
  const [row] =
    what === 'sleeping'
      ? await t.db.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event = 'PgSleep'
            AND query ILIKE '%UPDATE%"TonTransfer"%'`
      : await t.db.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity a
          WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
            AND EXISTS (
              SELECT 1 FROM pg_stat_activity s
              WHERE s.pid = ANY (pg_blocking_pids(a.pid))
                AND (s.pid = ${blocker ?? -1}
                  OR (s.wait_event = 'PgSleep' AND s.query ILIKE '%UPDATE%"TonTransfer"%')))`;
  return row?.n ?? 0;
}

async function until(what: 'sleeping' | 'blocked', blocker?: number): Promise<void> {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
    if ((await sessionsWaiting(what, blocker)) > 0) return;
    await sleep(10);
  }
  throw new Error(`no session of this test was ${what}`);
}

/** pg_sleep inside every UPDATE of this transfer: its writer holds all three row locks meanwhile. */
async function withSlowTransfer<T>(transferId: string, run: () => Promise<T>): Promise<T> {
  const name = `ggpin_test_dlt_${transferId.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  await t.db.$executeRawUnsafe(`
    CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(0.6); RETURN NEW; END $$`);
  await t.db.$executeRawUnsafe(
    `CREATE TRIGGER ${name} BEFORE UPDATE ON "TonTransfer" FOR EACH ROW
     WHEN (NEW.id = '${transferId}') EXECUTE FUNCTION ${name}()`,
  );
  try {
    return await run();
  } finally {
    await t.db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "TonTransfer"`);
    await t.db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
  }
}

type End = 'BOUNCED' | 'DELIVERED';

/** Exactly one of the two ends, with every row agreeing; money unmoved either way. */
async function oneEnd(c: Collision): Promise<End> {
  const rows = await rowsOf(t.db, c);
  const transfer = await t.db.tonTransfer.findUniqueOrThrow({ where: { id: c.transferId } });
  const attempt = await t.db.fulfillmentAttempt.findUniqueOrThrow({
    where: { id: transfer.attemptId ?? '' },
  });
  const delivered = await t.db.orderEvent.count({ where: { orderId: c.orderId, to: 'DELIVERED' } });
  const { ledger } = await r.moneyOf(c.orderId);
  expect(ledger.map((entry) => entry.kind)).toEqual(['PURCHASE']);
  if (transfer.status === 'BOUNCED') {
    expect([rows.order.status, attempt.status, delivered]).toEqual(['NEEDS_REVIEW', 'UNKNOWN', 0]);
    expect(tonFactOf(attempt.response, 'bounce')).toMatchObject({
      returnTxHash: expect.any(String) as unknown,
    });
    return 'BOUNCED';
  }
  expect(transfer.status).toBe('CONFIRMED');
  expect([rows.order.status, attempt.status, delivered]).toEqual(['DELIVERED', 'CONFIRMED', 1]);
  expect(tonFactOf(attempt.response, 'bounce')).toBeNull();
  return 'DELIVERED';
}

/** The DELIVERED end: the next tick's late step keeps the facts and tells the owner. */
async function lateBounceHeard(rec: Reconciler, c: Collision): Promise<void> {
  const report = await rec.service.tick();
  expect(countsOf(report, 'late')).toMatchObject({ LATE_BOUNCE: 1 });
  const attempt = (await rowsOf(t.db, c)).attempt;
  expect(tonFactOf(attempt.response, 'lateBounce')).not.toBeNull();
  expect((await t.db.tonTransfer.findUniqueOrThrow({ where: { id: c.transferId } })).status).toBe(
    'CONFIRMED',
  );
  expect((await r.moneyOf(c.orderId)).order.status).toBe('DELIVERED');
  const alert = { kind: 'OWNER_ALERT', alert: 'tonBounced', refId: c.transferId } as const;
  expect(await r.hasJob(alert)).toBe(true);
}

/** `first` is held inside its transaction (pg_sleep); `second` starts and waits for its locks. */
async function inOrder(c: Collision, first: TonOutcome, second: TonOutcome) {
  const a = countingRepository(t.db);
  const b = countingRepository(t.db);
  return withSlowTransfer(c.transferId, async () => {
    const one = a.repo.apply(c.transferId, first);
    await until('sleeping');
    const two = b.repo.apply(c.transferId, second);
    await until('blocked');
    const [x, y] = await Promise.all([one, two]);
    return { first: x.applied, second: y.applied, tries: a.tries.n + b.tries.n };
  });
}

describe('DL-T: the BOUNCED classifier and the worker DELIVERED on one transfer', () => {
  it('DELIVERED first, BOUNCED waits: DELIVERED, then the late step: lateBounce + tonBounced', async () => {
    const rec = await r.boot();
    const c = await collision(rec);
    expect(await inOrder(c, c.delivered, c.bounced)).toEqual({
      first: true,
      second: false,
      tries: 2,
    });
    expect(await oneEnd(c)).toBe('DELIVERED');
    await lateBounceHeard(rec, c);
    expect(t.gateway.callCount('sendBoc')).toBe(1);
  });

  it('BOUNCED first, DELIVERED waits: BOUNCED + NEEDS_REVIEW, never delivered, the tick leaves it', async () => {
    const rec = await r.boot();
    const c = await collision(rec);
    expect(await inOrder(c, c.bounced, c.delivered)).toEqual({
      first: true,
      second: false,
      tries: 2,
    });
    expect(await oneEnd(c)).toBe('BOUNCED');
    const report = await rec.service.tick();
    expect(countsOf(report, 'review')).toEqual({ 'skip:NOT_PROVABLE': 1 });
    expect(await oneEnd(c)).toBe('BOUNCED');
    expect(t.gateway.callCount('sendBoc')).toBe(1);
  });

  it('at the same moment, three rounds: always exactly one end', async () => {
    const rec = await r.boot();
    for (let round = 0; round < 3; round += 1) {
      const c = await collision(rec);
      const a = countingRepository(t.db).repo;
      const b = countingRepository(t.db).repo;
      const [x, y] = await Promise.all([
        a.apply(c.transferId, c.delivered),
        b.apply(c.transferId, c.bounced),
      ]);
      expect([x.applied, y.applied].filter(Boolean)).toHaveLength(1);
      if ((await oneEnd(c)) === 'DELIVERED') await lateBounceHeard(rec, c);
    }
  });

  it('a deadlock forced in the guard direction (transfer, then order): 40P01 retried, one end', async () => {
    const rec = await r.boot();
    const c = await collision(rec);
    const { repo, tries } = countingRepository(t.db);
    const rival = t.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "TonTransfer" WHERE "id" = ${c.transferId} FOR UPDATE`;
        const [me] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        // The classifier holds the order and attempt, and waits for this transfer lock.
        await until('blocked', me?.pid ?? -1);
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${c.orderId} FOR SHARE`;
        return 'committed' as const;
      },
      { timeout: 30_000 },
    );
    await sleep(50);
    const applied = repo.apply(c.transferId, c.bounced);
    const [rivalEnd, result] = await Promise.all([
      rival.catch((error: unknown) => (error instanceof Error ? error.message : 'failed')),
      applied,
    ]);
    // The classifier began to wait first, so its deadlock check fires first: it is the victim,
    // rolled back and run again (a second try), and the rival commits.
    expect(rivalEnd).toBe('committed');
    expect(tries.n).toBe(2);
    expect(result.applied).toBe(true);
    expect(await oneEnd(c)).toBe('BOUNCED');
  });
});
