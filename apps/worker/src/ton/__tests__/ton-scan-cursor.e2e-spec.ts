import type { Prisma } from '@repo/db';
import { scanCursorJson } from '../ton-scan-cursor';
import { ADVISORY_LOOKS_BEFORE_RESCAN } from '../ton-scan-trust';
import {
  payRequest,
  rowsOf,
  tonFactOf,
  untilSecondLook,
  type PayoutFixture,
} from './ton-e2e.fixtures';
import {
  PAST_VALID_SEC,
  SIGN_AT_SEC,
  TEST_TIMING,
  pinChain,
  useTonE2e,
  type TonInstance,
} from './ton-e2e.harness';

// Phase 5 S9 L-2 (Q-14) on the real database: the scan's progress of an ORDER transfer is kept in
// `attempt.response.ton.scan`, so a restarted worker goes on from it instead of reading a spammed
// wallet again; a cursor that is not bound to this transfer AND its message counts as none (the
// scan starts over, the safe direction).

const t = useTonE2e();
const SPAM = 600;
const FULL_SCAN_PAGES = Math.ceil(SPAM / 100);

/** The getTransactions calls one look of a fresh worker makes. */
async function pagesOfOneLook(transferId: string): Promise<number> {
  const worker = await t.boot({ wallet: t.wallet, gateway: t.gateway });
  const before = t.gateway.callCount('getTransactions');
  const look = await worker.confirm.check(transferId);
  expect(look.verdict?.kind).toBe('WAIT');
  return t.gateway.callCount('getTransactions') - before;
}

async function keptScan(fixture: PayoutFixture): Promise<Record<string, unknown>> {
  const scan = tonFactOf((await rowsOf(t.db, fixture)).attempt.response, 'scan');
  if (typeof scan !== 'object' || scan === null) throw new Error('no scan cursor kept');
  return { ...scan };
}

async function rewriteScan(fixture: PayoutFixture, scan: Record<string, unknown>): Promise<void> {
  const { attempt } = await rowsOf(t.db, fixture);
  const response = attempt.response;
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    throw new Error('no response');
  }
  const ton = { ...(response['ton'] as Prisma.JsonObject), scan: scan as Prisma.JsonObject };
  await t.db.fulfillmentAttempt.update({
    where: { id: fixture.attemptId },
    data: { response: { ...response, ton } },
  });
}

/** A payout in review (lost, or held until the test releases it), its wallet spammed at once. */
async function spammedInReview(
  scenario: 'LOSE' | 'HOLD' = 'LOSE',
): Promise<{ fixture: PayoutFixture; transferId: string }> {
  const sender: TonInstance = await t.boot({
    wallet: t.wallet,
    gateway: t.gateway,
    timing: { confirmTimeoutMs: 1_500 },
  });
  sender.hooks.afterBroadcastFn = () => {
    t.gateway.receiveSpam(t.wallet.address, SPAM);
    return Promise.resolve();
  };
  t.gateway.nextSend(scenario);
  const fixture = await t.order();
  expect(await sender.sender.pay(payRequest(fixture))).toMatchObject({
    status: 'REVIEW',
    transferStatus: 'BROADCAST',
  });
  return { fixture, transferId: (await rowsOf(t.db, fixture)).transfer?.id ?? '' };
}

/** The kept cursor rewritten to cover a transaction above every real one. */
async function hugeCursor(fixture: PayoutFixture, transferId: string): Promise<void> {
  const transfer = (await rowsOf(t.db, fixture)).transfer;
  if (transfer === null) throw new Error('no transfer');
  const binding = { id: transferId, extMsgHash: transfer.extMsgHash };
  const huge = { lt: 10n ** 18n, hash: 'cd'.repeat(32) };
  await rewriteScan(fixture, { ...scanCursorJson(binding, { covered: huge, pass: null }) });
}

/** The kept cursor rewritten to a pass whose next transaction does not exist; its message hash. */
async function bogusPass(fixture: PayoutFixture, transferId: string): Promise<string> {
  const transfer = (await rowsOf(t.db, fixture)).transfer;
  if (transfer === null) throw new Error('no transfer');
  const fresh = await t.gateway.getAccountState(t.wallet.address);
  if (fresh.lastTx === null) throw new Error('no transactions');
  const next = { lt: fresh.lastTx.lt - 1n, hash: 'ee'.repeat(32) };
  const binding = { id: transferId, extMsgHash: transfer.extMsgHash };
  const pass = { anchor: { state: fresh, atMs: null }, next };
  await rewriteScan(fixture, { ...scanCursorJson(binding, { covered: null, pass }) });
  return transfer.extMsgHash;
}

describe('TON scan cursor kept in the database (S9 L-2)', () => {
  it('a restarted worker goes on from the kept cursor: a page instead of the whole spam', async () => {
    const { fixture, transferId } = await spammedInReview();
    const scan = await keptScan(fixture);
    const transfer = (await rowsOf(t.db, fixture)).transfer;
    expect(scan).toMatchObject({ transferId, extMsgHash: transfer?.extMsgHash });
    expect(scan['covered']).not.toBeNull();

    expect(await pagesOfOneLook(transferId)).toBeLessThanOrEqual(2);
  });

  it('a cursor of another message or another transfer is refused: the scan starts over', async () => {
    const { fixture, transferId } = await spammedInReview();
    const scan = await keptScan(fixture);

    await rewriteScan(fixture, { ...scan, extMsgHash: 'f'.repeat(64) });
    expect(await pagesOfOneLook(transferId)).toBeGreaterThanOrEqual(FULL_SCAN_PAGES);
    // That look kept its own progress, bound to this transfer and message again.
    expect(await keptScan(fixture)).toMatchObject({ transferId, extMsgHash: scan['extMsgHash'] });

    await rewriteScan(fixture, { ...scan, transferId: 'cmh1other0000000000000001' });
    expect(await pagesOfOneLook(transferId)).toBeGreaterThanOrEqual(FULL_SCAN_PAGES);

    await rewriteScan(fixture, { ...scan, covered: { lt: 'not a number', hash: 'x' } });
    expect(await pagesOfOneLook(transferId)).toBeGreaterThanOrEqual(FULL_SCAN_PAGES);
  });

  it('a decided transfer keeps its last cursor: nothing writes it any more', async () => {
    const { fixture, transferId } = await spammedInReview('HOLD');
    const before = await keptScan(fixture);
    t.gateway.releaseHeld();
    t.gateway.receiveSpam(t.wallet.address, 150);
    const worker = await t.boot({ wallet: t.wallet, gateway: t.gateway });
    expect((await worker.confirm.check(transferId)).state.transferStatus).toBe('CONFIRMED');
    expect(await keptScan(fixture)).toEqual(before);
    await worker.confirm.check(transferId);
    expect(await keptScan(fixture)).toEqual(before);
  });

  // Audit L-1: a kept cursor the chain contradicts is a hint only. It is dropped (and the drop is
  // kept), the scan starts over, and the transfer is decided as if there had been no cursor.
  it('L-1: a cursor covering a transaction above the chain is dropped at once', async () => {
    const { fixture, transferId } = await spammedInReview('HOLD');
    await hugeCursor(fixture, transferId);
    t.gateway.releaseHeld();
    const worker = await t.boot({ wallet: t.wallet, gateway: t.gateway });
    expect((await worker.confirm.check(transferId)).state.transferStatus).toBe('CONFIRMED');
  });

  it('L-1: a kept pass whose next transaction does not exist: dropped after the limit, then confirmed', async () => {
    const { fixture, transferId } = await spammedInReview('HOLD');
    t.gateway.releaseHeld();
    const extMsgHash = await bogusPass(fixture, transferId);
    const worker = await t.boot({ wallet: t.wallet, gateway: t.gateway });
    for (let look = 0; look < ADVISORY_LOOKS_BEFORE_RESCAN; look += 1) {
      const result = await worker.confirm.check(transferId);
      expect(result.verdict).toEqual({ kind: 'WAIT', detail: 'INDEX_STALE' });
    }
    // The drop is kept: a restart now starts over too, never from the contradicted pass.
    expect(await keptScan(fixture)).toEqual({ transferId, extMsgHash, covered: null, pass: null });
    expect((await worker.confirm.check(transferId)).state.transferStatus).toBe('CONFIRMED');
  });

  // Audit R-1: the same pass, but the listing from the unknown cursor fails. That toncenter answers
  // so is an ASSUMPTION (TAXMIN) until the S12 testnet fixture records its real answer.
  it('R-1: a kept pass whose next is answered with an error: forgotten after the limit', async () => {
    const { fixture, transferId } = await spammedInReview('HOLD');
    t.gateway.releaseHeld();
    t.gateway.unknownCursor = 'ERROR';
    const extMsgHash = await bogusPass(fixture, transferId);
    const worker = await t.boot({ wallet: t.wallet, gateway: t.gateway });
    for (let look = 0; look < ADVISORY_LOOKS_BEFORE_RESCAN; look += 1) {
      const result = await worker.confirm.check(transferId);
      expect(result.verdict).toEqual({ kind: 'WAIT', detail: 'GATEWAY' });
    }
    expect(await keptScan(fixture)).toEqual({ transferId, extMsgHash, covered: null, pass: null });
    expect((await worker.confirm.check(transferId)).state.transferStatus).toBe('CONFIRMED');
  });

  // Review m1: the drop never costs the "not sent" proof of a payout that truly never landed.
  it('L-1: a lost payout under a cursor above the chain: dropped, two observations, EXPIRED', async () => {
    pinChain(t.gateway, SIGN_AT_SEC);
    const { fixture, transferId } = await spammedInReview('LOSE');
    await hugeCursor(fixture, transferId);
    pinChain(t.gateway, PAST_VALID_SEC);
    const worker = await t.boot({ wallet: t.wallet, gateway: t.gateway });
    expect((await worker.confirm.check(transferId)).verdict?.kind).toBe('EXPIRY_SEEN');
    const head = await t.gateway.getAccountState(t.wallet.address);
    expect(await keptScan(fixture)).toMatchObject({ covered: { lt: head.lastTx?.lt.toString() } });
    await untilSecondLook(t.db, fixture.attemptId, TEST_TIMING.expiryGapSec);
    expect((await worker.confirm.check(transferId)).state).toMatchObject({
      transferStatus: 'EXPIRED',
      orderStatus: 'NEEDS_REVIEW',
    });
  });
});
