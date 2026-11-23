import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { getQueueToken } from '@nestjs/bullmq';
import { StaleOrderStateError, failAndRefundOrder } from '@repo/db';
import { QUEUES, coreHoldNote } from '@repo/shared';
import type { Queue } from 'bullmq';
import { AppError } from '../../common/exceptions/app-error';
import { OrderRetryService } from '../../modules/orders/admin/order-retry.service';
import {
  buildOrdersCatalog,
  type OrdersCatalog,
} from '../../modules/orders/__tests__/orders-e2e.fixtures';
import { heldOrder } from './order-cli.fixtures';
import { ACTOR, useOpsE2e } from './ops-e2e.harness';

// Phase 5 S9i, S9e SA L-3(c): the owner's `order:retry` (the REAL OrderRetryService of the CLI
// module graph) and the worker's HELD_MAX_AGE_MS refund at once, on the real database. The API
// cannot import the worker, so its refund is replayed here with the very helper and arguments of
// apps/worker/src/reconcile/orders/held-writes.ts (`failAndRefundOrder` from HELD, HELD_EXPIRED,
// actor system, in one transaction, then the same-hold re-count); the worker's read-only payout
// pre-check is left out (these orders never had a payout). Test triggers (pg_sleep on one row's
// INSERT) hold one side inside its transaction, with its row locks, while the other queues behind
// it: either order wins in turn, and racing freely they still end QUEUED or REFUNDED, never both.

const queued: string[] = [];
afterAll(async () => {
  for (const id of queued)
    await fulfillQueue()
      .remove(id)
      .catch(() => 0);
});
const t = useOpsE2e();
const fulfillQueue = (): Queue => t.app().get<Queue>(getQueueToken(QUEUES.FULFILL_ORDER));
let catalog: OrdersCatalog;

beforeAll(async () => {
  catalog = await buildOrdersCatalog(t.db(), randomBytes(4).toString('hex'));
});

// The worker's HELD_EXPIRED_NOTE (apps/worker/src/reconcile/orders/held-release-policy.ts): the API
// cannot import the worker, and an export only for this test is not worth it. Keep the two in sync
// with that constant and with the call in held-writes.ts (HeldWriter.refund).
const HELD_EXPIRED_NOTE = 'reconcile: held for HELD_MAX_AGE_MS, refunded';

async function newHeldOrder(): Promise<string> {
  const userId = await t.user();
  const orderId = await heldOrder(
    t.db(),
    catalog,
    userId,
    coreHoldNote('ADAPTER_ERROR', 'e2e race'),
    'ADAPTER_ERROR',
  );
  queued.push(orderId);
  return orderId;
}

/** The worker's refund write (held-writes.ts HeldWriter.refund, minus its read-only pre-check). */
async function workerRefund(orderId: string): Promise<'refunded' | 'stale'> {
  const heldEvents = await t.db().orderEvent.count({ where: { orderId, to: 'HELD' } });
  try {
    await t.db().$transaction(
      async (tx) => {
        await failAndRefundOrder(tx, {
          orderId,
          from: 'HELD',
          reason: 'HELD_EXPIRED',
          actor: 'system',
          note: HELD_EXPIRED_NOTE,
        });
        const now = await tx.orderEvent.count({ where: { orderId, to: 'HELD' } });
        if (now !== heldEvents) throw new Error('hold changed');
      },
      { timeout: 30_000 },
    );
    return 'refunded';
  } catch (error) {
    if (error instanceof StaleOrderStateError) return 'stale';
    throw error;
  }
}

/** Released, or the exact refusal: NOT_HELD (no longer HELD under the lock), STATE_CHANGED (CAS). */
async function operatorRetry(orderId: string): Promise<'released' | 'NOT_HELD' | 'STATE_CHANGED'> {
  try {
    const outcome = await t
      .app()
      .get(OrderRetryService)
      .retry({ orderId, reason: 'checked the wallet history', operator: ACTOR.operator });
    if (outcome.applied) return 'released';
    throw new Error('retry answered "already released" for an order this test never released');
  } catch (error) {
    // NOT_HELD: the order was no longer HELD under the lock; STATE_CHANGED: the compare-and-set.
    const reason = error instanceof AppError ? error.details?.['reason'] : undefined;
    if (error instanceof AppError && error.code === 'VALIDATION_ERROR') {
      if (reason === 'NOT_HELD' || reason === 'STATE_CHANGED') return reason;
    }
    throw error;
  }
}

/**
 * Until this test's own sessions are where it needs them (S9i gate A3): `sleeping` — a session
 * inserting into `table` sleeps in the test trigger; `blocked` — a session waits for a lock on
 * "Order" that a session sleeping in the trigger holds (pg_blocking_pids). Another client of the
 * database (sleeping or waiting on anything else) does not count.
 */
async function waiting(
  what: 'sleeping' | 'blocked',
  table: 'LedgerEntry' | 'AuditLog',
): Promise<void> {
  const inserting = `%INSERT INTO%"${table}"%`;
  for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
    const [row] =
      what === 'sleeping'
        ? await t.db().$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event = 'PgSleep'
              AND query ILIKE ${inserting}`
        : await t.db().$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity a
            WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
              AND a.query ILIKE '%"Order"%'
              AND EXISTS (
                SELECT 1 FROM pg_stat_activity s
                WHERE s.pid = ANY (pg_blocking_pids(a.pid)) AND s.wait_event = 'PgSleep'
                  AND s.query ILIKE ${inserting})`;
    if ((row?.n ?? 0) > 0) return;
    await sleep(10);
  }
  throw new Error(`no session of this test was ${what} (${table})`);
}

/** pg_sleep before one row of `table` is inserted for this order (its writer keeps its locks). */
async function slowInsert<T>(
  table: 'LedgerEntry' | 'AuditLog',
  orderId: string,
  run: () => Promise<T>,
) {
  const name = `ggpin_test_l3c_${table.toLowerCase()}_${orderId.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  const when =
    table === 'LedgerEntry'
      ? `NEW."refId" = '${orderId}' AND NEW."kind" = 'REFUND'`
      : `NEW."targetId" = '${orderId}' AND NEW."action" = 'ORDER_RETRY'`;
  await t.db().$executeRawUnsafe(`
    CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(0.8); RETURN NEW; END $$`);
  await t.db().$executeRawUnsafe(
    `CREATE TRIGGER ${name} BEFORE INSERT ON "${table}" FOR EACH ROW WHEN (${when})
     EXECUTE FUNCTION ${name}()`,
  );
  try {
    return await run();
  } finally {
    await t.db().$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "${table}"`);
    await t.db().$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
  }
}

/** QUEUED with one ORDER_RETRY row and a job, no REFUND; or REFUNDED with one REFUND, no row. */
async function oneEnd(orderId: string): Promise<'QUEUED' | 'REFUNDED'> {
  const order = await t.db().order.findUniqueOrThrow({ where: { id: orderId } });
  const refunds = await t.db().ledgerEntry.findMany({
    where: { refType: 'ORDER', refId: orderId, kind: 'REFUND' },
  });
  const retries = await t.db().auditLog.count({
    where: { targetId: orderId, action: 'ORDER_RETRY' },
  });
  const purchase = await t.db().ledgerEntry.findFirstOrThrow({
    where: { refType: 'ORDER', refId: orderId, kind: 'PURCHASE' },
  });
  if (order.status === 'QUEUED') {
    expect([refunds.length, retries]).toEqual([0, 1]);
    expect((await fulfillQueue().getJob(orderId))?.id).toBe(orderId);
    return 'QUEUED';
  }
  expect(order).toMatchObject({ status: 'REFUNDED', statusReason: 'HELD_EXPIRED' });
  expect(refunds.map((e) => [e.userId, e.amountTiyin])).toEqual([
    [purchase.userId, -purchase.amountTiyin],
  ]);
  expect(retries).toBe(0);
  expect(await fulfillQueue().getJob(orderId)).toBeUndefined();
  return 'REFUNDED';
}

describe('L-3(c): order:retry (real OrderRetryService) and the worker HELD refund at once', () => {
  it('the refund holds its locks first: the retry waits, then is refused; REFUNDED', async () => {
    const orderId = await newHeldOrder();
    const [refund, retry] = await slowInsert('LedgerEntry', orderId, async () => {
      const first = workerRefund(orderId);
      await waiting('sleeping', 'LedgerEntry');
      const second = operatorRetry(orderId);
      await waiting('blocked', 'LedgerEntry');
      return Promise.all([first, second]);
    });
    // Exactly NOT_HELD: the retry re-read the order under its lock and found it REFUNDED (mutant
    // L1: without the status check it would go on and fail elsewhere).
    expect([refund, retry]).toEqual(['refunded', 'NOT_HELD']);
    expect(await oneEnd(orderId)).toBe('REFUNDED');
  });

  it('the retry holds its locks first: the refund waits, then is stale; QUEUED', async () => {
    const orderId = await newHeldOrder();
    const [retry, refund] = await slowInsert('AuditLog', orderId, async () => {
      const first = operatorRetry(orderId);
      await waiting('sleeping', 'AuditLog');
      const second = workerRefund(orderId);
      await waiting('blocked', 'AuditLog');
      return Promise.all([first, second]);
    });
    expect([retry, refund]).toEqual(['released', 'stale']);
    expect(await oneEnd(orderId)).toBe('QUEUED');
  });

  it('racing freely, four rounds: QUEUED or REFUNDED, never both, never neither', async () => {
    for (let round = 0; round < 4; round += 1) {
      const orderId = await newHeldOrder();
      const [refund, retry] = await Promise.all([workerRefund(orderId), operatorRetry(orderId)]);
      expect([refund === 'refunded', retry === 'released'].filter(Boolean)).toHaveLength(1);
      const end = await oneEnd(orderId);
      expect(end).toBe(refund === 'refunded' ? 'REFUNDED' : 'QUEUED');
    }
  });
});
