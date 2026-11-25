import type { TestingModule } from '@nestjs/testing';
import { failAndRefundOrder, transitionOrder, type PrismaClient } from '@repo/db';
import { coreHoldNote } from '@repo/shared';
import { Address, type Transaction } from '@ton/core';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { FakeTonGateway } from '../fake-ton.gateway';
import type { FakeDestinationScenario } from '../fake-ton-state';
import type { TonChainWitness } from '../ton-gateway';
import { TonLateReader } from '../ton-late-reader';
import { TonLateRepository } from '../ton-late.repository';
import { TonLateService } from '../ton-late.service';
import { TonNotifier } from '../ton-notifier';
import type { TonSenderService } from '../ton-sender.service';
import { TON_HOT_WALLET_ADDRESS, type TonHotWalletAddress, type TonTiming } from '../ton-tokens';
import { E2E_PAY_ADDRESSES, payRequest, rowsOf, type PayoutFixture } from './ton-e2e.fixtures';
import {
  PAST_VALID_SEC,
  SIGN_AT_SEC,
  TEST_TIMING,
  pinChain,
  type TestSenderHooks,
  type TonE2e,
} from './ton-e2e.harness';

// The late chain facts (S9f) on the real database: TonLateService is built here from a booted TON
// module's own providers (its wiring into TonModule is the coordinator's, s9f-wiring.md), on the
// in-memory chain. Nothing reaches toncenter, testnet or mainnet; nothing is signed or sent by the
// late code (the payouts below are the S5 sender's, as the fulfill worker makes them).

export const hex = (tx: Transaction | undefined): string | undefined => tx?.hash().toString('hex');

export function lateServiceOf(
  moduleRef: TestingModule,
  gateway: FakeTonGateway,
  witnesses: readonly TonChainWitness[] = [],
  timing: TonTiming = TEST_TIMING,
): TonLateService {
  const repository = new TonLateRepository(moduleRef.get(PrismaService));
  const reader = new TonLateReader(gateway, timing, witnesses);
  return new TonLateService(
    repository,
    reader,
    moduleRef.get(TonNotifier),
    moduleRef.get<symbol, TonHotWalletAddress>(TON_HOT_WALLET_ADDRESS),
    timing,
    E2E_PAY_ADDRESSES,
  );
}

/**
 * A test device: the fake chain's clock goes back inside the held message's validity, the message
 * lands, and the clock returns past valid_until. On the real chain this is a lagging node that
 * answered "not there" twice while the message was there (the false EXPIRED of D-60 (2)).
 */
export function landHeld(gateway: FakeTonGateway): void {
  pinChain(gateway, SIGN_AT_SEC + 1);
  gateway.releaseHeld();
  pinChain(gateway, PAST_VALID_SEC);
}

export interface Payer {
  readonly sender: TonSenderService;
  readonly hooks: TestSenderHooks;
}

/** A payout counted EXPIRED (attempt FAILED) whose message reached the chain afterwards. */
export async function falseExpired(
  db: PrismaClient,
  gateway: FakeTonGateway,
  payer: Payer,
  fixture: PayoutFixture,
  destination: FakeDestinationScenario = 'PROCESS',
) {
  const request = payRequest(fixture);
  gateway.destination(Address.parseRaw(request.toAddress), destination);
  pinChain(gateway, SIGN_AT_SEC);
  gateway.nextSend('HOLD');
  payer.hooks.afterBroadcastFn = () => {
    pinChain(gateway, PAST_VALID_SEC);
    return Promise.resolve();
  };
  const result = await payer.sender.pay(request);
  payer.hooks.afterBroadcastFn = () => Promise.resolve();
  if (result.status !== 'EXPIRED') throw new Error(`expected EXPIRED, got ${result.status}`);
  landHeld(gateway);
  const rows = await rowsOf(db, fixture);
  if (rows.transfer === null) throw new Error('the payout stored no transfer');
  return { request, transferId: rows.transfer.id };
}

/** What the reconciler does to a HELD order past HELD_MAX_AGE_MS (I-4): FAILED, then REFUNDED. */
export async function heldExpiredRefund(db: PrismaClient, fixture: PayoutFixture): Promise<void> {
  // Every customer has a wallet row (the refund locks it first); the TON fixture has none.
  await db.wallet.create({ data: { userId: fixture.userId } });
  await db.$transaction((tx) =>
    transitionOrder(tx, {
      orderId: fixture.orderId,
      from: 'PROCESSING',
      to: 'HELD',
      actor: 'system',
      reason: 'ADAPTER_ERROR',
      note: coreHoldNote('ADAPTER_ERROR', 'late-facts e2e'),
    }),
  );
  await db.$transaction((tx) =>
    failAndRefundOrder(tx, {
      orderId: fixture.orderId,
      from: 'HELD',
      reason: 'HELD_EXPIRED',
      actor: 'system',
      note: 'reconcile: held for HELD_MAX_AGE_MS, refunded',
    }),
  );
}

/** The user's ledger, oldest first (kind and amount). */
export function ledgerOf(db: PrismaClient, userId: string) {
  return db.ledgerEntry.findMany({
    where: { userId },
    select: { kind: true, amountTiyin: true, refId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

/**
 * A CONSUMED_UNMATCHED payout: another message of the same seqno (the same payout) took it. The
 * destination answers the twin as `destination` says.
 */
export async function consumedByTwin(t: TonE2e, destination: FakeDestinationScenario = 'PROCESS') {
  const fixture = await t.order();
  const request = payRequest(fixture);
  t.gateway.destination(Address.parseRaw(request.toAddress), destination);
  t.ton.hooks.afterStoredFn = async (transferId) => {
    const row = await t.db.tonTransfer.findUniqueOrThrow({ where: { id: transferId } });
    const twin = t.wallet.sign({
      seqno: row.seqno,
      validUntilSec: Math.floor(row.validUntil.getTime() / 1_000) - 1,
      to: Address.parseRaw(request.toAddress),
      amountNano: request.amountNano,
      body: request.payload,
      bounce: true,
      deploy: false,
    });
    await t.gateway.sendBoc(twin.boc);
  };
  t.gateway.nextSend('LAND', 'LOSE');
  const result = await t.ton.sender.pay(request);
  t.ton.hooks.afterStoredFn = () => Promise.resolve();
  if (result.status !== 'REVIEW' || result.transferStatus !== 'CONSUMED_UNMATCHED') {
    throw new Error(`expected CONSUMED_UNMATCHED, got ${JSON.stringify(result)}`);
  }
  const rows = await rowsOf(t.db, fixture);
  // Our external message's transaction (a bounce adds the returned value after it).
  const twin = t.gateway
    .transactionsOf(t.wallet.address)
    .filter((tx) => tx.inMessage?.info.type === 'external-in')
    .at(-1);
  return {
    fixture,
    request,
    transferId: rows.transfer?.id ?? '',
    ref: { txHash: hex(twin) ?? '', lt: String(twin?.lt) },
  };
}

/**
 * Attempt 1 counted EXPIRED; attempt 2 signs the same seqno and, before its broadcast, attempt 1's
 * message lands: attempt 2 is CONSUMED_UNMATCHED and holds the seqno (a live row), so attempt 1
 * can never be written CONFIRMED (the live-seqno unique index).
 */
export async function liveHoldsSeqno(t: TonE2e) {
  const fixture = await t.order();
  const request = payRequest(fixture);
  pinChain(t.gateway, SIGN_AT_SEC);
  t.gateway.nextSend('HOLD');
  t.ton.hooks.afterBroadcastFn = () => {
    pinChain(t.gateway, PAST_VALID_SEC);
    return Promise.resolve();
  };
  const first = await t.ton.sender.pay(request);
  t.ton.hooks.afterBroadcastFn = () => Promise.resolve();
  if (first.status !== 'EXPIRED') throw new Error(`expected EXPIRED, got ${first.status}`);
  const next = await t.attempt(fixture, 2);
  t.ton.hooks.afterStoredFn = () => {
    landHeld(t.gateway);
    return Promise.resolve();
  };
  t.gateway.nextSend('LOSE');
  const second = await t.ton.sender.pay(payRequest(next, { toAddress: request.toAddress }));
  t.ton.hooks.afterStoredFn = () => Promise.resolve();
  if (second.status !== 'REVIEW' || second.transferStatus !== 'CONSUMED_UNMATCHED') {
    throw new Error(`expected CONSUMED_UNMATCHED, got ${JSON.stringify(second)}`);
  }
  const landed = t.gateway.transactionsOf(t.wallet.address).at(-1);
  return {
    fixture,
    next,
    firstId: (await rowsOf(t.db, fixture)).transfer?.id ?? '',
    liveId: (await rowsOf(t.db, next)).transfer?.id ?? '',
    landed: { txHash: hex(landed) ?? '', lt: String(landed?.lt) },
  };
}
