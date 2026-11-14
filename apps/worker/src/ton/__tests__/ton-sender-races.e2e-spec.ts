import { createPrismaClient, type PrismaClient } from '@repo/db';
import { parseMajor } from '@repo/shared';
import { Address, beginCell } from '@ton/core';
import type { TonCheck } from '../ton-confirm.service';
import type { TonPayResult } from '../ton-payout';
import { TonTransferRepository, type StoreRequest } from '../ton-transfer.repository';
import type { TonWallet } from '../ton-wallet';
import {
  E2E_PAY_ADDRESSES,
  eventsTo,
  payee,
  payRequest,
  rowsOf,
  transfersOf,
  type PayoutFixture,
} from './ton-e2e.fixtures';
import { useTonE2e } from './ton-e2e.harness';

// Two senders at once (rules/70 "concurrent requests", docs/06 "bitta hamyonga bitta yuboruvchi"):
// the Redis lock is only cooperative; the partial unique indexes of migration 10 (one unresolved
// message per wallet, one live message per seqno) are the fence, proven here on two connections.

const t = useTonE2e();
const TON = (major: string): bigint => parseMajor('TON', major);

function storeRequest(wallet: TonWallet, fixture: PayoutFixture): StoreRequest {
  const to = Address.parseRaw(payee());
  const chainTimeSec = Math.floor(Date.now() / 1_000);
  const validUntilSec = chainTimeSec + 60;
  const amountNano = TON('1');
  return {
    order: { orderId: fixture.orderId, attemptId: fixture.attemptId, allowedTo: E2E_PAY_ADDRESSES },
    network: 'testnet',
    walletAddress: wallet.rawAddress,
    toAddress: to.toRawString(),
    amountNano,
    seqno: 0,
    validUntilSec,
    limits: { perOrderMaxNano: TON('50'), dailyMaxNano: TON('500') },
    chainTimeSec,
    maxSignLagSec: 90,
    sign: () =>
      wallet.sign({
        seqno: 0,
        validUntilSec,
        to,
        amountNano,
        body: beginCell().storeUint(0, 32).endCell(),
        bounce: true,
        deploy: false,
      }),
  };
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}

async function waitForLockWaiter(db: PrismaClient): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const rows = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS "n" FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('no connection ever waited on the unique index');
}

describe('TON payout: two senders at once', () => {
  const clients: PrismaClient[] = [];
  const connection = () => {
    const client = createPrismaClient(t.env.DATABASE_URL);
    clients.push(client);
    return new TonTransferRepository({ client });
  };

  afterAll(async () => {
    for (const client of clients) await client.$disconnect();
  });

  it('two connections sign for one wallet at once: one SIGNED row, the other BUSY (3 rounds)', async () => {
    const [a, b] = [connection(), connection()];
    for (let round = 0; round < 3; round += 1) {
      const wallet = t.newWallet();
      const [fa, fb] = [await t.order(), await t.order()];
      const results = await Promise.all([
        a.signAndStore(storeRequest(wallet, fa)),
        b.signAndStore(storeRequest(wallet, fb)),
      ]);
      expect(results.map((r) => r.kind).sort()).toEqual(['BUSY', 'STORED']);
      expect(await transfersOf(t.db, wallet.rawAddress)).toHaveLength(1);
      const loser = results[0]?.kind === 'BUSY' ? fa : fb;
      // The loser's transaction rolled back whole: no reference, still SENDING (it may retry).
      expect((await rowsOf(t.db, loser)).attempt).toMatchObject({
        status: 'SENDING',
        externalRef: null,
      });
    }
  });

  it('the unique index is the fence: a writer past the busy check still gets BUSY when the other commits', async () => {
    const wallet = t.newWallet();
    const [held, late] = [await t.order(), await t.order()];
    const inserted = deferred();
    const commit = deferred();
    const blocker = createPrismaClient(t.env.DATABASE_URL);
    clients.push(blocker);
    const request = storeRequest(wallet, held);
    const signed = request.sign();
    const holding = blocker.$transaction(
      async (tx) => {
        await tx.tonTransfer.create({
          data: {
            purpose: 'ORDER',
            attemptId: held.attemptId,
            network: 'testnet',
            walletAddress: wallet.rawAddress,
            seqno: 0,
            validUntil: new Date(request.validUntilSec * 1_000),
            toAddress: request.toAddress,
            amountNanoTon: request.amountNano,
            payloadHash: signed.payloadHash,
            extMsgHash: signed.extMsgHash,
            bocBase64: signed.bocBase64,
            status: 'SIGNED',
          },
        });
        inserted.resolve();
        await commit.promise;
      },
      { timeout: 20_000 },
    );
    await inserted.promise;
    // Its busy check cannot see the uncommitted row: it reaches the insert and waits on the index.
    const racing = connection().signAndStore(storeRequest(wallet, late));
    await waitForLockWaiter(t.db);
    commit.resolve();
    await holding;
    expect(await racing).toEqual({ kind: 'BUSY' });
    expect((await transfersOf(t.db, wallet.rawAddress)).map((r) => r.attemptId)).toEqual([
      held.attemptId,
    ]);
    expect((await rowsOf(t.db, late)).attempt.externalRef).toBeNull();
  });

  it('two workers pay two orders at the same moment: the wallet lock lets one sign; the other retries later', async () => {
    t.gateway.latencyMs = 20;
    const other = await t.boot({ wallet: t.wallet, gateway: t.gateway });
    const [fa, fb] = [await t.order(), await t.order()];
    const results = await Promise.all([
      t.ton.sender.pay(payRequest(fa)),
      other.sender.pay(payRequest(fb)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['DELIVERED', 'NOT_SENT']);
    expect(results).toContainEqual({ status: 'NOT_SENT', reason: 'WALLET_BUSY' });
    expect(t.gateway.callCount('sendBoc')).toBe(1);
    const loser = results[0]?.status === 'NOT_SENT' ? fa : fb;
    expect((await rowsOf(t.db, loser)).transfer).toBeNull();
    expect((await t.ton.sender.pay(payRequest(loser))).status).toBe('DELIVERED');
    const rows = await transfersOf(t.db, t.wallet.rawAddress);
    const won = rows.find((r) => r.attemptId !== loser.attemptId);
    const retried = rows.find((r) => r.attemptId === loser.attemptId);
    expect(rows).toHaveLength(2);
    expect((retried?.seqno ?? 0) - (won?.seqno ?? 0)).toBe(1);
  });

  it('the lock lost (both granted): the second worker finds the open message and signs nothing', async () => {
    const a = await t.boot({ wallet: t.wallet, gateway: t.gateway, noRedisLock: true });
    const b = await t.boot({ wallet: t.wallet, gateway: t.gateway, noRedisLock: true });
    const [fa, fb] = [await t.order(), await t.order()];
    const seen: TonPayResult[] = [];
    a.hooks.afterStoredFn = async () => {
      seen.push(await b.sender.pay(payRequest(fb)));
    };
    expect((await a.sender.pay(payRequest(fa))).status).toBe('DELIVERED');
    expect(seen).toEqual([{ status: 'NOT_SENT', reason: 'WALLET_BUSY' }]);
    expect(t.gateway.callCount('sendBoc')).toBe(1);
    expect(await transfersOf(t.db, t.wallet.rawAddress)).toHaveLength(1);
    expect((await rowsOf(t.db, fb)).attempt).toMatchObject({
      status: 'SENDING',
      externalRef: null,
    });
  });

  it('two checks of one transfer at once (a second worker, the reconciler): one write, one DELIVERED event', async () => {
    const other = await t.boot({ wallet: t.wallet, gateway: t.gateway });
    const fixture = await t.order();
    const checks: TonCheck[] = [];
    t.ton.hooks.afterBroadcastFn = async (transferId) => {
      checks.push(
        ...(await Promise.all([t.ton.confirm.check(transferId), other.confirm.check(transferId)])),
      );
    };
    expect((await t.ton.sender.pay(payRequest(fixture))).status).toBe('DELIVERED');
    expect(checks.map((c) => c.state.transferStatus)).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(checks.map((c) => c.state.orderStatus)).toEqual(['DELIVERED', 'DELIVERED']);
    expect(await eventsTo(t.db, fixture.orderId, 'DELIVERED')).toBe(1);
    await t.expectJobs([{ kind: 'ORDER_DELIVERED', orderId: fixture.orderId }]);
  });

  it('the balance watch on the database: a WalletSnapshot per reading, the alert names the low one', async () => {
    expect(await t.ton.monitor.tick(0)).toBe('OK');
    t.gateway.setBalance(t.wallet.address, t.env.TON_MIN_BALANCE_ALERT_NANO - 1n);
    expect(await t.ton.monitor.tick(1)).toBe('ALERTED');
    const rows = await t.db.walletSnapshot.findMany({ where: { address: t.wallet.rawAddress } });
    expect(rows.map((r) => r.nanoTon).sort((x, y) => (x < y ? -1 : 1))).toEqual([
      t.env.TON_MIN_BALANCE_ALERT_NANO - 1n,
      parseMajor('TON', '100'),
    ]);
    expect(rows.every((r) => r.network === 'testnet' && r.microUsdt === 0n)).toBe(true);
    const low = rows.find((r) => r.nanoTon < t.env.TON_MIN_BALANCE_ALERT_NANO);
    await t.expectJobs([{ kind: 'ALERT', alert: 'tonLowBalance', refId: low?.id ?? '' }]);
  });
});
