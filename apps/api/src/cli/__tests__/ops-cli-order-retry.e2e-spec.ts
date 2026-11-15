import { randomBytes } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { ATTEMPT_LIMIT_HOLD_WHY, QUEUES, coreHoldNote } from '@repo/shared';
import type { Queue } from 'bullmq';
import { OrderAdminRepository } from '../../modules/orders/admin/order-admin.repository';
import {
  buildOrdersCatalog,
  type OrdersCatalog,
} from '../../modules/orders/__tests__/orders-e2e.fixtures';
import { heldAfterAttempts, heldOrder, reviewOrder } from './order-cli.fixtures';
import { ACTOR, useOpsE2e } from './ops-e2e.harness';

// order:retry on the real database (phase 5 S10 + fix round items 1 and 4): a release of a HELD
// order queues fulfill-order under jobId = orderId with its audit in the same transaction; an order
// whose send attempts are used up is refused by COUNTING them (the worker's rule), whatever its
// hold note says; without the audit row nothing changes.

// Declared before the harness: jest runs afterAll hooks in declaration order, and the jobs must
// be removed while the harness's queues are still open.
const queuedOrders: string[] = [];
afterAll(async () => {
  for (const id of queuedOrders)
    await fulfillQueue()
      .remove(id)
      .catch(() => 0);
});
const t = useOpsE2e();
const WHO = ['--reason', 'checked the wallet history', '--operator', ACTOR.operator];
let catalog: OrdersCatalog;
const fulfillQueue = (): Queue => t.app().get<Queue>(getQueueToken(QUEUES.FULFILL_ORDER));

/** The note the worker writes for the attempt cap (fulfill-fresh.ts), through the shared formatter. */
const WORKER_LIMIT_NOTE = coreHoldNote('ADAPTER_ERROR', ATTEMPT_LIMIT_HOLD_WHY);

beforeAll(async () => {
  catalog = await buildOrdersCatalog(t.db(), randomBytes(4).toString('hex'));
});

function fields(out: readonly string[]): Record<string, string> {
  const all: Record<string, string> = {};
  for (const line of out) {
    const at = line.indexOf('=');
    if (at > 0) all[line.slice(0, at)] = line.slice(at + 1);
  }
  return all;
}

async function untouched(orderId: string): Promise<void> {
  const order = await t.db().order.findUniqueOrThrow({ where: { id: orderId } });
  expect(order.status).toBe('HELD');
  expect(await fulfillQueue().getJob(orderId)).toBeUndefined();
  expect(await t.db().auditLog.count({ where: { targetId: orderId } })).toBe(0);
}

describe('order:retry (real Postgres)', () => {
  it('HELD -> QUEUED with the audit and a fulfill-order job whose id is the order id; a re-run writes nothing', async () => {
    const userId = await t.user();
    const orderId = await heldOrder(t.db(), catalog, userId, 'wallet below the reserve');
    queuedOrders.push(orderId);
    const argv = ['order:retry', orderId, ...WHO];
    const first = await t.run(argv);
    expect(first.err).toEqual([]);
    expect(first.code).toBe(0);
    const done = fields(first.out);
    expect(done).toMatchObject({ applied: 'true', status: 'QUEUED', jobQueued: 'true' });
    const order = await t.db().order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('QUEUED');
    const audit = await t.audit(done['audit'] ?? '');
    expect(audit).toMatchObject({ action: 'ORDER_RETRY', actorType: 'CLI', targetId: orderId });
    const job = await fulfillQueue().getJob(orderId);
    expect(job?.id).toBe(orderId);
    expect(job?.data).toEqual({ orderId });

    const again = await t.run(argv);
    expect(again.code).toBe(0);
    expect(fields(again.out)).toMatchObject({ applied: 'false', jobQueued: 'true' });
    expect(await t.db().auditLog.count({ where: { targetId: orderId } })).toBe(1);
  });

  it('send attempts used up (the worker note, the worker rule): refused and explained, nothing written', async () => {
    const userId = await t.user();
    const orderId = await heldAfterAttempts(
      t.db(),
      catalog,
      userId,
      ['TON_EXPIRED', 'NOT_SENT'],
      WORKER_LIMIT_NOTE,
    );
    queuedOrders.push(orderId);
    const refused = await t.run(['order:retry', orderId, ...WHO]);
    expect(refused.code).toBe(1);
    const err = refused.err.join('\n');
    expect(err).toContain('ATTEMPT_LIMIT_NOT_SUPPORTED');
    expect(err).toContain('HELD_MAX_AGE');
    await untouched(orderId);
    // The old confirmation flag no longer exists.
    const flagged = await t.run(['order:retry', orderId, ...WHO, '--confirm-attempt-limit']);
    expect(flagged.code).toBe(2);
    await untouched(orderId);
  });

  it('the refusal counts attempts, not the note: another wording is refused all the same', async () => {
    const userId = await t.user();
    const orderId = await heldAfterAttempts(
      t.db(),
      catalog,
      userId,
      ['TON_EXPIRED', 'TON_EXPIRED'],
      'core hold: ADAPTER_ERROR (attempts exhausted, reworded)',
    );
    queuedOrders.push(orderId);
    const refused = await t.run(['order:retry', orderId, ...WHO]);
    expect(refused.code).toBe(1);
    expect(refused.err.join('\n')).toContain('ATTEMPT_LIMIT_NOT_SUPPORTED');
    await untouched(orderId);
  });

  it('below the cap (a hold-failed attempt does not count) the hold is released', async () => {
    const userId = await t.user();
    // One payout proven not sent, then an attempt the TON module failed before signing.
    const orderId = await heldAfterAttempts(
      t.db(),
      catalog,
      userId,
      ['TON_EXPIRED', 'LOW_BALANCE'],
      'ton: balance below amount + reserve',
      'LOW_BALANCE',
    );
    queuedOrders.push(orderId);
    const ok = await t.run(['order:retry', orderId, ...WHO]);
    expect(ok.err).toEqual([]);
    expect(ok.code).toBe(0);
    expect(fields(ok.out)).toMatchObject({ applied: 'true', jobQueued: 'true' });
    const order = await t.db().order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('QUEUED');
  });

  it('CR m2: when the audit row cannot be written the order stays HELD and no job is queued', async () => {
    const userId = await t.user();
    const orderId = await heldOrder(t.db(), catalog, userId, 'wallet below the reserve');
    queuedOrders.push(orderId);
    const repo = t.app().get(OrderAdminRepository);
    const spy = jest
      .spyOn(repo, 'createAudit')
      .mockRejectedValueOnce(new Error('audit insert refused'));
    try {
      const failed = await t.run(['order:retry', orderId, ...WHO]);
      expect(failed.code).toBe(1);
    } finally {
      spy.mockRestore();
    }
    await untouched(orderId);
  });

  it('a state other than HELD is refused', async () => {
    const userId = await t.user();
    const { orderId } = await reviewOrder(t.db(), catalog, userId, 'EXPIRED');
    const notHeld = await t.run(['order:retry', orderId, ...WHO]);
    expect(notHeld.code).toBe(1);
    expect(notHeld.err.join('\n')).toContain('NOT_HELD');
    expect(await fulfillQueue().getJob(orderId)).toBeUndefined();
  });
});
