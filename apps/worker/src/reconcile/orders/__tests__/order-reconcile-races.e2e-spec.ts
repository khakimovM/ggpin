import { setTimeout as sleep } from 'node:timers/promises';
import { rowsOf } from '../../../ton/__tests__/ton-e2e.fixtures';
import { PAST_VALID_SEC, pinChain } from '../../../ton/__tests__/ton-e2e.harness';
import { episodeRef } from '../guard-ref';
import { countsOf, useReconcileE2e, type Reconciler } from './reconcile-e2e.harness';

// Plan §4.1 / §4.3 on the real database: two reconcilers at once pay one refund (the database
// compare-and-set, with the Redis order lock out of the way); a fulfill run holding the order lock
// keeps the reconciler off its order and off the chain; a DB guard refusal (GG001) is one alert
// per order and hour and is never retried inside the tick.

const r = useReconcileE2e();
const { t } = r;
const PAST_GAP_MS = 1_500;

/** A lost payout of a NEEDS_REVIEW order, written EXPIRED by the TON module (two looks). */
async function expiredInReview(rec: Reconciler) {
  const fixture = await r.timedOut(rec, 'LOSE');
  pinChain(t.gateway, PAST_VALID_SEC);
  await rec.confirm.check(fixture.transferId);
  await sleep(PAST_GAP_MS);
  expect((await rec.confirm.check(fixture.transferId)).state).toMatchObject({
    transferStatus: 'EXPIRED',
    orderStatus: 'NEEDS_REVIEW',
  });
  return fixture;
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
});
