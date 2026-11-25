import { transitionOrder } from '@repo/db';
import { TonTransferRepository } from '../../ton/ton-transfer.repository';
import type { TonPayResult } from '../../ton/ton-payout';
import { ScriptedPayer, expire, release, type ReleaseActor } from './attempt-release.fixtures';
import { attemptsOf, orderRow } from './fulfill-e2e.fixtures';
import { useFulfillE2e, type FulfillInstance } from './fulfill-e2e.harness';

// The attempt cap after a release (phase 5 S9b, D-64 (5), D-66 (2), plan §12-§13): only the
// OWNER's release (CLI owner channel, or the panel's OWNER role) starts the count again, from the
// `before.maxAttemptNo` its audit row stored. An OPERATOR or SYSTEM row, a corrupt number or one
// above the order's own attempts counts every attempt: the order is held at once, nothing is paid.
// A release therefore gives at most MAX_SEND_ATTEMPTS new attempts, each only after the previous
// one was proven NOT sent: never more than one payout.

const t = useFulfillE2e();
let main: FulfillInstance;
const run = (orderId: string) => main.service.run(orderId, { finalAttempt: false });
const CLI: ReleaseActor = { kind: 'CLI' };

/** Every pay() expires: the attempt is FAILED (TON_EXPIRED), the order stays PROCESSING. */
async function expiringOrder() {
  const payer = new ScriptedPayer((request) => expire(t.db, request));
  main = await t.boot({ payer });
  const { orderId } = await t.order();
  await expect(run(orderId)).resolves.toBe('DONE');
  return { payer, orderId };
}

async function heldByCap(orderId: string, attempts: number): Promise<void> {
  expect(await orderRow(t.db, orderId)).toEqual(
    expect.objectContaining({ status: 'HELD', statusReason: 'ADAPTER_ERROR' }),
  );
  expect(await attemptsOf(t.db, orderId)).toHaveLength(attempts);
  const latest = await t.db.orderEvent.findFirstOrThrow({
    where: { orderId, to: 'HELD' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  expect(latest.note).toContain('every attempt was proven not sent');
}

describe('attempt cap: the OWNER release', () => {
  it('CLI owner release: two new attempts, then held again; without a release no more', async () => {
    const { payer, orderId } = await expiringOrder();
    expect(payer.calls).toHaveLength(2);
    await heldByCap(orderId, 2);

    expect(await release(t.db, orderId, CLI)).toBe(true);
    await expect(run(orderId)).resolves.toBe('DONE');
    expect(payer.calls).toHaveLength(4);
    expect((await attemptsOf(t.db, orderId)).map((a) => a.attemptNo)).toEqual([1, 2, 3, 4]);
    await heldByCap(orderId, 4);

    // Regression: back to QUEUED without any audit row (the old OWNER row says 2): held at once.
    await t.db.$transaction((tx) =>
      transitionOrder(tx, { orderId, from: 'HELD', to: 'QUEUED', actor: 'system' }),
    );
    await expect(run(orderId)).resolves.toBe('DONE');
    expect(payer.calls).toHaveLength(4);
    await heldByCap(orderId, 4);
  });

  it('the panel OWNER (actorType ADMIN, role OWNER) releases the same way', async () => {
    const { payer, orderId } = await expiringOrder();
    expect(await release(t.db, orderId, { kind: 'ADMIN', role: 'OWNER' })).toBe(true);
    await run(orderId);
    expect(payer.calls).toHaveLength(4);
    await heldByCap(orderId, 4);
  });

  it.each<[string, ReleaseActor]>([
    ['an OPERATOR (ADMIN, role OPERATOR)', { kind: 'ADMIN', role: 'OPERATOR' }],
    [
      'an ADMIN row whose actor claims the CLI (CR L2)',
      { kind: 'ADMIN', role: 'OWNER', type: 'CLI' },
    ],
    ['a SYSTEM row', { kind: 'SYSTEM' }],
  ])('%s resets nothing: held again before any payout', async (_name, actor) => {
    const { payer, orderId } = await expiringOrder();
    expect(await release(t.db, orderId, actor)).toBe(true);
    await expect(run(orderId)).resolves.toBe('DONE');
    expect(payer.calls).toHaveLength(2);
    await heldByCap(orderId, 2);
  });

  it('an OPERATOR row newer than the OWNER row is skipped: the OWNER number still counts', async () => {
    const { payer, orderId } = await expiringOrder();
    await release(t.db, orderId, CLI); // maxAttemptNo 2
    await run(orderId); // attempts 3 and 4 expire
    // The OPERATOR stores 4; were it read, two more attempts would follow.
    await release(t.db, orderId, { kind: 'ADMIN', role: 'OPERATOR' });
    await run(orderId);
    expect(payer.calls).toHaveLength(4);
    await heldByCap(orderId, 4);
  });

  it('SYSTEM rows newer than the OWNER row never push it out of the scan window', async () => {
    const { payer, orderId } = await expiringOrder();
    await release(t.db, orderId, CLI);
    const owner = await t.db.auditLog.findFirstOrThrow({ where: { targetId: orderId } });
    // More SYSTEM rows than the repository looks through; were they read, no OWNER row is seen.
    await t.db.auditLog.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        actorType: 'SYSTEM',
        action: 'ORDER_RETRY',
        targetType: 'Order',
        targetId: orderId,
        before: { status: 'HELD', maxAttemptNo: 2 },
        after: { status: 'QUEUED' },
        createdAt: new Date(owner.createdAt.getTime() + 1_000 + i),
      })),
    });
    await run(orderId);
    expect(payer.calls).toHaveLength(4);
    await heldByCap(orderId, 4);
  });

  it.each([
    ['missing', { status: 'HELD' }],
    ['negative', { status: 'HELD', maxAttemptNo: -1 }],
    ['a fraction', { status: 'HELD', maxAttemptNo: 1.5 }],
    ['a string', { status: 'HELD', maxAttemptNo: '2' }],
    ['above the order’s attempts (10^9, clamp)', { status: 'HELD', maxAttemptNo: 1_000_000_000 }],
    ['above the order’s attempts by one (clamp)', { status: 'HELD', maxAttemptNo: 3 }],
  ])('a corrupt maxAttemptNo (%s) counts every attempt', async (_name, before) => {
    const { payer, orderId } = await expiringOrder();
    expect(await release(t.db, orderId, CLI, { before, raw: true })).toBe(true);
    await expect(run(orderId)).resolves.toBe('DONE');
    expect(payer.calls).toHaveLength(2);
    await heldByCap(orderId, 2);
  });
});

describe('attempt cap: hold attempts and races', () => {
  it('attempts a hold failed before signing (LIMIT_*) never count; an OPERATOR may release such a hold', async () => {
    const transfers = t.main.moduleRef.get(TonTransferRepository, { strict: false });
    const payer = new ScriptedPayer(async (request, call): Promise<TonPayResult> => {
      if (call !== 2) return expire(t.db, request);
      await transfers.holdBeforeSigning(request.orderId, request.attemptId, 'LIMIT_DAILY');
      return { status: 'HELD', reason: 'LIMIT_DAILY' };
    });
    main = await t.boot({ payer });
    const { orderId } = await t.order();
    await run(orderId); // #1 expires, #2 is held (LIMIT_DAILY)
    expect((await attemptsOf(t.db, orderId)).map((a) => a.error)).toEqual([
      'TON_EXPIRED',
      'LIMIT_DAILY',
    ]);
    expect((await orderRow(t.db, orderId)).statusReason).toBe('LIMIT_DAILY');
    // No reset by the OPERATOR: #1 still counts, the hold attempt #2 never did -> exactly one more.
    await release(t.db, orderId, { kind: 'ADMIN', role: 'OPERATOR' });
    await run(orderId);
    expect(payer.calls).toHaveLength(3);
    await heldByCap(orderId, 3);
  });

  it('two releases and a run at once: one audit row, two new attempts, never a third', async () => {
    const { payer, orderId } = await expiringOrder();
    const [a, b] = await Promise.all([
      release(t.db, orderId, CLI),
      release(t.db, orderId, CLI),
      run(orderId),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    // The run may have seen HELD (a replay) or QUEUED (it ran): run until it settles.
    await run(orderId);
    await run(orderId);
    expect(await t.db.auditLog.count({ where: { targetId: orderId } })).toBe(1);
    expect(payer.calls).toHaveLength(4);
    await heldByCap(orderId, 4);
  });
});
