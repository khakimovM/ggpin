import { randomBytes } from 'node:crypto';
import { ATTEMPT_LIMIT_HOLD_WHY, HELD_AUTO_RELEASE_MAX } from '@repo/shared';
import { RESELLER_STARS_ADAPTER } from '../../../adapters/simulator/simulated-reseller.adapter';
import {
  attemptsOf,
  ledgerOf,
  orderRow,
  transfersOf,
} from '../../../fulfillment/__tests__/fulfill-e2e.fixtures';
import { WALLET_BALANCE } from '../../../fulfillment/__tests__/fulfill-e2e.harness';
import { pinChain } from '../../../ton/__tests__/ton-e2e.harness';
import { TON_HOT_WALLET_ADDRESS, type TonHotWalletAddress } from '../../../ton/ton-tokens';
import { WALLET_BLOCKED_REMIND_EVERY_MS as PERIOD } from '../guard-ref';
import { useHeldE2e, type HeldReconciler } from './held-sweep.e2e-kit';

// Phase 5 S9e, the releases (D-64 (4), Q-3, Q-8, items 25/32/34) and the blocked-wallet reminder
// (S9c fix 2). A release is HELD -> QUEUED by SYSTEM (`reconcile release: <REASON>`) plus the
// fulfill-order job, only when the run would not hold the order again; ADAPTER_ERROR never; at
// most HELD_AUTO_RELEASE_MAX times. The run that follows (t.main, by hand) re-checks everything.

const h = useHeldE2e();
const { t } = h;
const MINUTE = 60_000;

async function held(rc: HeldReconciler, orderId: string, after = MINUTE) {
  return rc.held.run({ nowMs: (await h.heldAtMs(orderId)) + after });
}

async function setRoute(productId: string, adapter: string, isEnabled: boolean): Promise<void> {
  await t.db.productRoute.updateMany({ where: { productId, adapter }, data: { isEnabled } });
}

describe('S9e: release when the cause is gone', () => {
  it('NO_ADAPTER: no route -> KEEP; the route back -> QUEUED + job, and the run delivers', async () => {
    pinChain(t.gateway, 0);
    const rc = await h.boot();
    const order = await h.order();
    await setRoute(order.productId, 'FRAGMENT', false);
    await h.holdAs(order.orderId, 'NO_ADAPTER');
    expect((await held(rc, order.orderId)).counts).toMatchObject({ 'keep:noRoute': 1 });
    expect((await orderRow(t.db, order.orderId)).status).toBe('HELD');

    await setRoute(order.productId, 'FRAGMENT', true);
    const report = await held(rc, order.orderId);
    expect(report.counts).toMatchObject({ released: 1 });
    expect((await orderRow(t.db, order.orderId)).status).toBe('QUEUED');
    const event = await t.db.orderEvent.findFirstOrThrow({
      where: { orderId: order.orderId, from: 'HELD', to: 'QUEUED' },
    });
    expect(event).toMatchObject({ actor: 'SYSTEM', note: 'reconcile release: NO_ADAPTER' });
    expect(await h.fulfillJobState(order.orderId)).toBe('waiting');
    await expect(t.main.service.run(order.orderId, { finalAttempt: false })).resolves.toBe('DONE');
    expect((await orderRow(t.db, order.orderId)).status).toBe('DELIVERED');
    expect(t.executedOnChain()).toBe(1);
  });

  it('item 34: a RESELLER handle, Fragment back: 31 min old KEEP, 10 min RELEASE, Fragment re-checks', async () => {
    pinChain(t.gateway, 0);
    const rc = await h.boot();
    const order = await h.order({ issuer: RESELLER_STARS_ADAPTER, routeAdapter: 'FRAGMENT' });
    await t.db.productRoute.create({
      data: { productId: order.productId, adapter: RESELLER_STARS_ADAPTER, priority: 2 },
    });
    await h.holdAs(order.orderId, 'NO_ADAPTER');
    const created = (await t.db.order.findUniqueOrThrow({ where: { id: order.orderId } }))
      .createdAt;
    const old = await rc.held.run({ nowMs: created.getTime() + 31 * MINUTE });
    expect(old.counts).toMatchObject({ 'keep:recheckStale': 1 });
    const young = await rc.held.run({ nowMs: created.getTime() + 10 * MINUTE });
    expect(young.counts).toMatchObject({ released: 1 });
    await expect(t.main.service.run(order.orderId, { finalAttempt: false })).resolves.toBe('DONE');
    expect((await orderRow(t.db, order.orderId)).status).toBe('DELIVERED');
    expect((await attemptsOf(t.db, order.orderId)).map((a) => a.adapter)).toEqual(['FRAGMENT']);
  });

  it('PRICE_ABOVE_MAX: a fresh cost above the ceiling KEEP, at or under it RELEASE', async () => {
    const rc = await h.boot();
    const order = await h.order();
    await h.holdAs(order.orderId, 'PRICE_ABOVE_MAX');
    const row = await t.db.order.findUniqueOrThrow({ where: { id: order.orderId } });
    const now = await h.dbNowMs();
    const snapshot = (costMinor: bigint, at: number) =>
      t.db.costSnapshot.create({
        data: {
          productId: order.productId,
          adapter: 'FRAGMENT',
          currency: 'TON',
          basisQuantity: row.quantity,
          costMinor,
          source: 'held-e2e',
          createdAt: new Date(at),
        },
      });
    await snapshot(row.maxCostMinor + 1n, now + 1_000);
    expect((await rc.held.run({ nowMs: now + 2_000 })).counts).toMatchObject({ 'keep:price': 1 });
    await snapshot(row.maxCostMinor, now + 3_000);
    expect((await rc.held.run({ nowMs: now + 4_000 })).counts).toMatchObject({ released: 1 });
  });

  it('LIMIT_PER_ORDER / LIMIT_DAILY: KEEP while the limit is below the cost, RELEASE once it is not', async () => {
    for (const [reason, key] of [
      ['LIMIT_PER_ORDER', 'TON_MAX_PER_ORDER_NANO'],
      ['LIMIT_DAILY', 'TON_MAX_DAILY_NANO'],
    ] as const) {
      const order = await h.order();
      await h.holdAs(order.orderId, reason);
      const tight = await h.boot({ env: { ...t.env, [key]: 1n } });
      expect((await held(tight, order.orderId)).counts).toMatchObject({ 'keep:limit': 1 });
      const normal = await h.boot();
      expect((await held(normal, order.orderId)).counts).toMatchObject({ released: 1 });
    }
  });

  it('LOW_BALANCE (the TON module hold): no reading KEEP, short KEEP, enough RELEASE -> delivered', async () => {
    pinChain(t.gateway, 0);
    t.gateway.setBalance(t.wallet.address, 100_000_000n);
    const order = await h.order();
    await t.main.service.run(order.orderId, { finalAttempt: false });
    expect(await orderRow(t.db, order.orderId)).toMatchObject({
      status: 'HELD',
      statusReason: 'LOW_BALANCE',
    });
    const rc = await h.boot();
    expect((await held(rc, order.orderId)).counts).toMatchObject({ 'keep:noBalance': 1 });
    const wallet = rc.moduleRef.get<TonHotWalletAddress>(TON_HOT_WALLET_ADDRESS, { strict: false });
    const reading = (nanoTon: bigint) =>
      t.db.walletSnapshot.create({
        data: { network: wallet.network, address: wallet.rawAddress, nanoTon, microUsdt: 0n },
      });
    await reading(100_000_000n);
    expect((await held(rc, order.orderId)).counts).toMatchObject({ 'keep:balance': 1 });
    t.gateway.setBalance(t.wallet.address, WALLET_BALANCE);
    await reading(WALLET_BALANCE);
    expect((await held(rc, order.orderId)).counts).toMatchObject({ released: 1 });
    await expect(t.main.service.run(order.orderId, { finalAttempt: false })).resolves.toBe('DONE');
    expect((await orderRow(t.db, order.orderId)).status).toBe('DELIVERED');
    expect(t.executedOnChain()).toBe(1);
  });

  it('ADAPTER_ERROR (the attempt cap among them) is never released, all else healthy', async () => {
    const rc = await h.boot();
    const order = await h.order();
    await h.holdAs(order.orderId, 'ADAPTER_ERROR', ATTEMPT_LIMIT_HOLD_WHY);
    expect((await held(rc, order.orderId)).counts).toMatchObject({ 'keep:adapterError': 1 });
    expect((await held(rc, order.orderId, 5 * 3_600_000)).counts).toMatchObject({
      'keep:adapterError': 1,
    });
    expect((await orderRow(t.db, order.orderId)).status).toBe('HELD');
    expect(await h.releasesOf(order.orderId)).toBe(0);
  });

  it(`at most ${String(HELD_AUTO_RELEASE_MAX)} releases: the next hold is KEEP (releaseCap)`, async () => {
    const rc = await h.boot();
    const order = await h.order();
    for (let i = 1; i <= HELD_AUTO_RELEASE_MAX; i += 1) {
      await h.holdAs(order.orderId, 'NO_ADAPTER');
      expect((await held(rc, order.orderId)).counts).toMatchObject({ released: 1 });
      expect(await h.releasesOf(order.orderId)).toBe(i);
    }
    await h.holdAs(order.orderId, 'NO_ADAPTER');
    expect((await held(rc, order.orderId)).counts).toMatchObject({ 'keep:releaseCap': 1 });
    expect((await orderRow(t.db, order.orderId)).status).toBe('HELD');
    expect((await ledgerOf(t.db, order.orderId)).map((l) => l.kind)).toEqual(['PURCHASE']);
  });
});

describe('S9e: the blocked-wallet reminder (S9c fix 2, fix round CR F6/F7)', () => {
  // The rows this test writes by hand are put back (or deleted) on the shared test database.
  afterAll(async () => {
    for (const undo of undoTransfers.splice(0).reverse()) await undo();
  });

  it('this wallet SIGNED/BROADCAST only, a full period after the block; never another wallet or network, CONFIRMED, EXPIRED', async () => {
    pinChain(t.gateway, 0);
    const main = await t.boot({ timing: { confirmTimeoutMs: TIMEOUT } });
    const delivered = await h.order();
    await main.service.run(delivered.orderId, { finalAttempt: false });
    expect((await orderRow(t.db, delivered.orderId)).status).toBe('DELIVERED');
    const elsewhere = await h.order();
    await main.service.run(elsewhere.orderId, { finalAttempt: false });
    const [other] = await transfersOf(t.db, elsewhere.orderId);
    if (other === undefined) throw new Error('no transfer');
    const lost = await h.order();
    t.gateway.nextSend('LOSE');
    await main.service.run(lost.orderId, { finalAttempt: false });
    expect((await orderRow(t.db, lost.orderId)).status).toBe('NEEDS_REVIEW');
    const [blocking] = await transfersOf(t.db, lost.orderId);
    const [confirmed] = await transfersOf(t.db, delivered.orderId);
    if (blocking === undefined || confirmed === undefined) throw new Error('no transfer');
    expect(blocking.status).toBe('BROADCAST');
    expect(confirmed.status).toBe('CONFIRMED');
    await keepForUndo(blocking.id);
    // The database allows one SIGNED/BROADCAST per wallet: the others live on another network or
    // address (still unresolved there), or are EXPIRED.
    const foreign = await foreignTransfers(blocking.id, other.id);
    const never = [confirmed.id, foreign.otherNetwork, foreign.otherWallet, foreign.expired];
    const named = async (n: number) => {
      const hits: string[] = [];
      for (const id of [blocking.id, ...never]) {
        if (await h.hasAlert('tonWalletBlocked', `${id}_wb_${String(n)}`)) hits.push(id);
      }
      return hits;
    };

    const rc = await h.boot({ timing: { confirmTimeoutMs: TIMEOUT } });
    const blocked = blocking.createdAt.getTime() + TIMEOUT;
    expect((await rc.walletBlocked.run({ nowMs: blocked + PERIOD - 1 })).counts).toEqual({});
    expect(await named(1)).toEqual([]);
    // BROADCAST on this wallet: named a full period after the block.
    const first = await rc.walletBlocked.run({ nowMs: blocked + PERIOD });
    expect(first.counts).toEqual({ reminded: 1 });
    expect(await named(1)).toEqual([blocking.id]);
    // SIGNED on this wallet: named too (next period).
    await setStatus(blocking.id, 'SIGNED');
    expect((await rc.walletBlocked.run({ nowMs: blocked + 2 * PERIOD })).counts).toEqual({
      reminded: 1,
    });
    expect(await named(2)).toEqual([blocking.id]);
    // EXPIRED: the wallet is free, nobody is named.
    await setStatus(blocking.id, 'EXPIRED');
    expect((await rc.walletBlocked.run({ nowMs: blocked + 3 * PERIOD })).counts).toEqual({});
    expect(await named(3)).toEqual([]);
  });
});

const TIMEOUT = 1_000;

const undoTransfers: (() => Promise<void>)[] = [];

/** 64 random hex digits: never a stored extMsgHash (UNIQUE) or this run's wallet. */
const hex64 = () => randomBytes(32).toString('hex');

/** Restores the transfer as it is now when the suite ends (its hand-made changes undone). */
async function keepForUndo(id: string): Promise<void> {
  const omit = { id: true, attemptId: true, updatedAt: true } as const;
  const was = await t.db.tonTransfer.findUniqueOrThrow({ where: { id }, omit });
  undoTransfers.push(() =>
    h.withTriggersOff((tx) => tx.tonTransfer.update({ where: { id }, data: was })),
  );
}

async function setStatus(id: string, status: 'SIGNED' | 'EXPIRED'): Promise<void> {
  await h.withTriggersOff((tx) => tx.tonTransfer.update({ where: { id }, data: { status } }));
}

/**
 * Transfers that must never be named (triggers off: tests only): another order's payout moved to
 * the other network as SIGNED (an ORDER row: a SELFTEST may only be testnet), and SELFTEST copies
 * of the blocking one at the same time, BROADCAST on another wallet address and EXPIRED here.
 */
async function foreignTransfers(templateId: string, otherNetworkId: string) {
  const row = await t.db.tonTransfer.findUniqueOrThrow({ where: { id: templateId } });
  expect(row.network).toBe('testnet');
  await keepForUndo(otherNetworkId);
  const variants = [
    ['otherWallet', { status: 'BROADCAST', walletAddress: `0:${hex64()}` }],
    ['expired', { status: 'EXPIRED' }],
  ] as const;
  const ids = { otherNetwork: otherNetworkId, otherWallet: '', expired: '' };
  await h.withTriggersOff(async (tx) => {
    await tx.tonTransfer.update({
      where: { id: otherNetworkId },
      data: {
        network: 'mainnet',
        status: 'SIGNED',
        txHash: null,
        txLt: null,
        feeNanoTon: null,
        confirmedAt: null,
        createdAt: row.createdAt,
      },
    });
    for (const [index, [name, variant]] of variants.entries()) {
      const created = await tx.tonTransfer.create({
        data: {
          purpose: 'SELFTEST',
          attemptId: null,
          network: 'testnet',
          walletAddress: row.walletAddress,
          seqno: row.seqno + 1_000 + index,
          validUntil: row.validUntil,
          toAddress: row.toAddress,
          amountNanoTon: row.amountNanoTon,
          payloadHash: row.payloadHash,
          extMsgHash: hex64(),
          bocBase64: row.bocBase64,
          createdAt: row.createdAt,
          ...variant,
        },
        select: { id: true },
      });
      ids[name] = created.id;
      undoTransfers.push(() =>
        h.withTriggersOff((tx) => tx.tonTransfer.delete({ where: { id: created.id } })),
      );
    }
  });
  return ids;
}
