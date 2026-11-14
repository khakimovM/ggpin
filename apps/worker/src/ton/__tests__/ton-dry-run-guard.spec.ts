import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { Test, type TestingModule } from '@nestjs/testing';
import { Address, beginCell } from '@ton/core';
import { TonClient } from '@ton/ton';
import { WorkerConfigModule } from '../../config/config.module';
import { buildTestEnv } from '../../config/__tests__/test-env';
import { PrismaModule } from '../../infra/prisma/prisma.module';
import { QueueModule } from '../../infra/queue/queue.module';
import { RedisModule } from '../../infra/redis/redis.module';
import { withFakeInfra } from '../../__tests__/fake-infra';
import { DisabledTonGateway } from '../disabled-ton.gateway';
import { FakeTonGateway } from '../fake-ton.gateway';
import { buildTonGateway, DRY_RUN_WALLET_BALANCE_NANO } from '../ton-factories';
import { TonGatewayError, type TonGateway } from '../ton-gateway';
import { TonSenderService } from '../ton-sender.service';
import {
  TON_GATEWAY,
  TON_HOT_WALLET_ADDRESS,
  TON_WALLET,
  type TonHotWalletAddress,
} from '../ton-tokens';
import { NO_PROGRESS, advanceScan } from '../ton-tx-scan';
import { ToncenterGateway } from '../toncenter.gateway';
import type { TonWallet } from '../ton-wallet';
import { TonModule } from '../ton.module';

// Plan §8 / brief: with FULFILLMENT_DRY_RUN=true no TonClient is ever constructed and nothing
// leaves the process. Every way out (fetch, TCP, TLS, http(s)) throws for the whole file, the
// TonClient constructor is counted, and the module is booted and driven through a payout cycle.

jest.mock('@ton/ton', () => {
  const actual: Record<string, unknown> = jest.requireActual('@ton/ton');
  return {
    ...actual,
    TonClient: jest.fn(() => {
      throw new Error('TonClient must never be built in a dry run');
    }),
  };
});

const blocked = () => {
  throw new Error('network access in a dry-run test');
};

describe('dry run: no TonClient, no network (plan §8)', () => {
  let moduleRef: TestingModule;
  const spies: jest.SpyInstance[] = [];

  beforeAll(async () => {
    spies.push(
      jest.spyOn(globalThis, 'fetch').mockImplementation(blocked),
      jest.spyOn(net.Socket.prototype, 'connect').mockImplementation(blocked),
      jest.spyOn(tls, 'connect').mockImplementation(blocked),
      jest.spyOn(http, 'request').mockImplementation(blocked),
      jest.spyOn(https, 'request').mockImplementation(blocked),
    );
    moduleRef = await withFakeInfra(
      Test.createTestingModule({
        imports: [
          WorkerConfigModule.forRoot(buildTestEnv()),
          PrismaModule,
          RedisModule,
          QueueModule,
          TonModule,
        ],
      }),
    ).compile();
    moduleRef.useLogger(false);
    await moduleRef.init();
  });

  afterAll(async () => {
    await moduleRef.close();
    for (const spy of spies) spy.mockRestore();
  });

  it('the guard itself trips (positive control)', async () => {
    await expect(Promise.resolve().then(() => fetch('https://toncenter.invalid'))).rejects.toThrow(
      'network access',
    );
    expect(() => net.connect(443, 'toncenter.invalid')).toThrow('network access');
    expect(
      () => new ToncenterGateway({ endpoint: 'https://toncenter.invalid', dryRun: true }),
    ).toThrow('never built with FULFILLMENT_DRY_RUN=true');
  });

  it('the module wires the fake chain and a throw-away wallet, and the sender resolves', () => {
    const gateway = moduleRef.get<TonGateway>(TON_GATEWAY);
    const wallet = moduleRef.get<TonWallet>(TON_WALLET);
    expect(gateway).toBeInstanceOf(FakeTonGateway);
    expect(wallet.dryRun).toBe(true);
    expect(moduleRef.get(TonSenderService)).toBeInstanceOf(TonSenderService);
    expect(gateway instanceof FakeTonGateway && gateway.balanceOf(wallet.address)).toBe(
      DRY_RUN_WALLET_BALANCE_NANO,
    );
    // The balance watch does not run in a dry run.
    expect(gateway instanceof FakeTonGateway && gateway.callCount('getBalance')).toBe(0);
    // Other modules get the address only (audit L1); it is the signer's address.
    const exported = moduleRef.get<TonHotWalletAddress>(TON_HOT_WALLET_ADDRESS);
    expect(exported.rawAddress).toBe(wallet.rawAddress);
    expect('sign' in exported).toBe(false);
  });

  it('a whole sign -> send -> find cycle runs on the fake chain without a socket', async () => {
    const gateway = moduleRef.get<TonGateway>(TON_GATEWAY);
    const wallet = moduleRef.get<TonWallet>(TON_WALLET);
    const state = await gateway.getAccountState(wallet.address);
    const signed = wallet.sign({
      seqno: 0,
      validUntilSec: state.chainTime + 60,
      to: new Address(0, Buffer.alloc(32, 9)),
      amountNano: 1_000_000n,
      body: beginCell().endCell(),
      bounce: true,
      deploy: false,
    });
    await gateway.sendBoc(signed.boc);
    const after = await gateway.getAccountState(wallet.address);
    const found = await advanceScan(
      {
        fetchPage: (page) => gateway.getTransactions(wallet.address, page),
        address: wallet.address,
        extMsgHash: signed.extMsgHash,
        sinceUtime: state.chainTime - 300,
      },
      NO_PROGRESS,
      () => Promise.resolve({ state: after, atMs: null }),
    );
    expect(found.kind).toBe('FOUND');
  });

  it('production + dry run: every chain call is refused, still without a TonClient', async () => {
    const wallet = moduleRef.get<TonWallet>(TON_WALLET);
    const gateway = buildTonGateway({ ...buildTestEnv(), NODE_ENV: 'production' }, wallet);
    expect(gateway).toBeInstanceOf(DisabledTonGateway);
    await expect(gateway.getAccountState(wallet.address)).rejects.toBeInstanceOf(TonGatewayError);
    await expect(gateway.sendBoc(Buffer.alloc(1))).rejects.toMatchObject({ reason: 'REFUSED' });
    expect(() => new FakeTonGateway({ production: true, dryRun: true })).toThrow('production');
  });

  it('no TonClient was constructed and no network call was attempted by the module', () => {
    expect(jest.mocked(TonClient)).not.toHaveBeenCalled();
    // Only the positive control above touched the guards.
    expect(spies[0]?.mock.calls.length).toBe(1);
    expect(spies[1]?.mock.calls.length).toBe(1);
    expect(spies.slice(2).every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });
});
