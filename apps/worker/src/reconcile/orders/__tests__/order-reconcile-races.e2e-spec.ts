import { setTimeout as sleep } from 'node:timers/promises';
import { StaleOrderStateError, resolveNeedsReview } from '@repo/db';
import { rowsOf, untilSecondLook } from '../../../ton/__tests__/ton-e2e.fixtures';
import { PAST_VALID_SEC, TEST_TIMING, pinChain } from '../../../ton/__tests__/ton-e2e.harness';
import { episodeRef } from '../guard-ref';
import { OrderReconcileRepository } from '../order-reconcile.repository';
import { decideReview, evidenceKey } from '../review-evidence';
import { EvidenceChangedError } from '../review-resolver';
import { writeTonFact } from './reconcile-e2e.fakes';
import { countsOf, useReconcileE2e, type Reconciler } from './reconcile-e2e.harness';

// Plan §4.1 / §4.3 on the real database: two reconcilers at once pay one refund (the database
// compare-and-set, with the Redis order lock out of the way); a fulfill run holding the order lock
// keeps the reconciler off its order and off the chain; a DB guard refusal (GG001) is one alert
// per order and hour and is never retried inside the tick. Evidence that changes under the
// resolution rolls it back (S9c review CR1); an operator and the reconciler at once leave one
// winner (audit I-4).

const r = useReconcileE2e();
const { t } = r;

/** A lost payout of a NEEDS_REVIEW order, written EXPIRED by the TON module (two looks). */
async function expiredInReview(rec: Reconciler) {
  const fixture = await r.timedOut(rec, 'LOSE');
  pinChain(t.gateway, PAST_VALID_SEC);
  await rec.confirm.check(fixture.transferId);
  await untilSecondLook(t.db, fixture.attemptId, TEST_TIMING.expiryGapSec);
  expect((await rec.confirm.check(fixture.transferId)).state).toMatchObject({
    transferStatus: 'EXPIRED',
    orderStatus: 'NEEDS_REVIEW',
  });
  return fixture;
}

/** The owner's MANUAL refund through the CLI, built here only (the worker never builds one, I-4). */
const OPERATOR = {
  kind: 'operator',
  type: 'CLI',
  id: 'owner-e2e',
  ip: null,
  osUser: 'e2e',
  otpVerified: true,
} as const;
const MANUAL = {
  kind: 'MANUAL',
  evidence: 'e2e: the owner checked the wallet history, the payout never left',
  reason: 'race test of the reconciler',
} as const;

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Until another session of this database waits for a row lock (the reconciler, held off). */
async function untilSomeoneWaits(): Promise<void> {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
    const [row] = await t.db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if ((row?.n ?? 0) > 0) return;
    await sleep(25);
  }
  throw new Error('the reconciler never waited for the operator');
}

async function onlyOneRefund(orderId: string): Promise<void> {
  const { order, ledger, audits } = await r.moneyOf(orderId);
  expect(order.status).toBe('REFUNDED');
  expect(ledger.map((e) => e.kind)).toEqual(['PURCHASE', 'REFUND']);
  expect(audits).toHaveLength(1);
}

describe('order reconciler: races and guard refusals (S9c)', () => {
  it('two reconcilers at once: one REFUND, one audit row, the other a silent no-op', async () => {
    const a = await r.boot({ grantingLock: true });
    const b = await r.boot({ grantingLock: true });
    const fixture = await expiredInReview(a);
    const [ra, rb] = await Promise.all([a.service.tick(), b.service.tick()]);
    const outcomes = [countsOf(ra, 'review'), countsOf(rb, 'review')];
    expect(outcomes).toEqual(expect.arrayContaining([{ refunded: 1 }, { stale: 1 }]));
    const { order, ledger, audits } = await r.moneyOf(fixture.orderId);
    expect(order.status).toBe('REFUNDED');
    expect(ledger.map((e) => e.kind)).toEqual(['PURCHASE', 'REFUND']);
    expect(audits).toHaveLength(1);
  });

  it('a fulfill run holds the order lock: the reconciler stays off the order and the chain', async () => {
    const rec = await r.boot();
    const fixture = await r.timedOut(rec, 'HOLD');
    t.gateway.releaseHeld();
    const reads = t.gateway.callCount('getTransactions');
    const report = await r.whileLocked(fixture.orderId, () => rec.service.tick());
    expect(countsOf(report, 'transfers')).toEqual({ busy: 1 });
    expect(countsOf(report, 'review')).toEqual({ busy: 1 });
    expect(t.gateway.callCount('getTransactions')).toBe(reads);
    expect((await rowsOf(t.db, fixture)).transfer?.status).toBe('BROADCAST');
    expect((await r.moneyOf(fixture.orderId)).order.status).toBe('NEEDS_REVIEW');
    // The lock is free again: the next tick decides.
    expect(countsOf(await rec.service.tick(), 'review')).toEqual({ delivered: 1 });
  });

  it('GG001: reconcileGuardRefused once per order and hour, nothing written, no retry', async () => {
    const rec = await r.boot();
    const fixture = await expiredInReview(rec);
    const guard = `ggpin_test_s9c_${fixture.orderId.toLowerCase()}`;
    // A guard of the test's own: refuses any change of THIS order (SQLSTATE GG001, like the
    // guards of migration 10). Every firing is counted in a sequence (sequences survive the
    // rollback), so a retry inside the tick would show.
    await t.db.$executeRawUnsafe(`CREATE SEQUENCE ${guard}_fired`);
    await t.db.$executeRawUnsafe(`
      CREATE FUNCTION ${guard}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${fixture.orderId}' THEN
          PERFORM nextval('${guard}_fired');
          RAISE EXCEPTION 'test guard' USING ERRCODE = 'GG001';
        END IF;
        RETURN NEW;
      END $$`);
    await t.db.$executeRawUnsafe(
      `CREATE TRIGGER ${guard} BEFORE UPDATE ON "Order" FOR EACH ROW EXECUTE FUNCTION ${guard}()`,
    );
    try {
      const first = await rec.service.tick();
      expect(countsOf(first, 'review')).toEqual({ guardRefused: 1 });
      const fired = async () =>
        Number(
          (
            await t.db.$queryRawUnsafe<{ n: string }[]>(
              `SELECT last_value::text AS n FROM ${guard}_fired`,
            )
          )[0]?.n,
        );
      expect(await fired()).toBe(1);
      const second = await rec.service.tick();
      expect(await fired()).toBe(2);
      const refs = new Set(
        [first.nowMs, second.nowMs].map((now) => episodeRef(fixture.orderId, 'review', now)),
      );
      const alerts = await r.jobIdsLike(`alert-reconcileGuardRefused-${fixture.orderId}`);
      expect(alerts).toHaveLength(refs.size);
      for (const ref of refs) {
        const refId = ref ?? '';
        expect(await r.hasJob({ kind: 'OWNER_ALERT', alert: 'reconcileGuardRefused', refId })).toBe(
          true,
        );
      }
    } finally {
      await t.db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${guard} ON "Order"`);
      await t.db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${guard}()`);
      await t.db.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS ${guard}_fired`);
    }
    const { order, ledger, audits } = await r.moneyOf(fixture.orderId);
    expect(order.status).toBe('NEEDS_REVIEW');
    expect(ledger.map((e) => e.kind)).toEqual(['PURCHASE']);
    expect(audits).toEqual([]);
    // With the guard gone the next tick resolves it as usual.
    expect(countsOf(await rec.service.tick(), 'review')).toEqual({ refunded: 1 });
  });

  it('CR1: evidence written under the resolution rolls it back, nothing moves', async () => {
    const rec = await r.boot();
    const fixture = await expiredInReview(rec);
    const attempts = await rec.moduleRef.get(OrderReconcileRepository).payoutOf(fixture.orderId);
    const decision = decideReview(attempts, {
      network: t.wallet.network,
      walletAddress: t.wallet.rawAddress,
      expiryGapSec: TEST_TIMING.expiryGapSec,
    });
    if (decision.kind !== 'REFUND') throw new Error(`decided ${decision.kind}`);
    // A TON write between the decision and the locked read: a suspect transaction recorded.
    await writeTonFact(t.db, fixture.attemptId, 'suspect', { test: true });
    const resolution = { to: 'FAILED', proof: decision.proof } as const;
    await expect(
      rec.resolver.resolve(fixture.orderId, resolution, evidenceKey(attempts)),
    ).rejects.toBeInstanceOf(EvidenceChangedError);
    const { order, ledger, audits } = await r.moneyOf(fixture.orderId);
    expect(order.status).toBe('NEEDS_REVIEW');
    expect(ledger.map((e) => e.kind)).toEqual(['PURCHASE']);
    expect(audits).toEqual([]);
    expect((await rowsOf(t.db, fixture)).attempt.status).not.toBe('FAILED');
  });

  it('I-4: the operator holds the order, the reconciler waits and then steps aside silently', async () => {
    const rec = await r.boot();
    const fixture = await expiredInReview(rec);
    const locked = deferred();
    const operator = t.db.$transaction(
      async (tx) => {
        const result = await resolveNeedsReview(tx, {
          orderId: fixture.orderId,
          to: 'FAILED',
          proof: MANUAL,
          resolver: OPERATOR,
        });
        locked.resolve();
        await untilSomeoneWaits();
        return result;
      },
      { timeout: 30_000 },
    );
    await Promise.race([locked.promise, operator]);
    const report = await rec.service.tick();
    expect((await operator).to).toBe('FAILED');
    expect(countsOf(report, 'review')).toEqual({ stale: 1 });
    expect(await r.jobIdsLike(`alert-reconcileGuardRefused-${fixture.orderId}`)).toEqual([]);
    await onlyOneRefund(fixture.orderId);
  });

  it('I-4: an operator and the reconciler at the same moment: one winner, one refund', async () => {
    const rec = await r.boot();
    const fixture = await expiredInReview(rec);
    const [byOperator, report] = await Promise.all([
      t.db
        .$transaction((tx) =>
          resolveNeedsReview(tx, {
            orderId: fixture.orderId,
            to: 'FAILED',
            proof: MANUAL,
            resolver: OPERATOR,
          }),
        )
        .then(
          () => 'won' as const,
          (error: unknown) => {
            if (error instanceof StaleOrderStateError) return 'stale' as const;
            throw error;
          },
        ),
      rec.service.tick(),
    ]);
    const reconciler = countsOf(report, 'review');
    if (byOperator === 'won') expect([{}, { stale: 1 }]).toContainEqual(reconciler);
    else expect(reconciler).toEqual({ refunded: 1 });
    await onlyOneRefund(fixture.orderId);
  });
});
