import { Logger } from '@nestjs/common';
import { parseMajor } from '@repo/shared';
import { buildTestEnv } from '../../config/__tests__/test-env';
import { tonLiveSource } from '../../config/__tests__/ton-live-env';
import { FakeTonGateway } from '../fake-ton.gateway';
import { LOW_BALANCE_REPEAT_MS, TonBalanceMonitor } from '../ton-balance.monitor';
import type { TonNotice } from '../ton-notices';
import { TonNotifier } from '../ton-notifier';
import type { TonSnapshotRepository } from '../ton-snapshot.repository';
import type { StoredTransfer, TonTransferRepository } from '../ton-transfer.repository';
import { dryRunTonWallet } from '../ton-wallet';

// The hot-wallet watch (rules/45, docs/06): one WalletSnapshot per reading, the alert on the
// first low reading and then every LOW_BALANCE_REPEAT_MS while it stays low; an unresolved transfer
// older than TON_CONFIRM_TIMEOUT_MS raises tonWalletBlocked (review M4); the clocks at boot (m5).

const THRESHOLD = parseMajor('TON', '100');

class Snapshots implements Pick<TonSnapshotRepository, 'record'> {
  readonly rows: { network: string; address: string; nanoTon: bigint }[] = [];
  failing = false;

  record(network: string, address: string, nanoTon: bigint): Promise<string> {
    if (this.failing) return Promise.reject(new Error('db down'));
    this.rows.push({ network, address, nanoTon });
    return Promise.resolve(`snap${String(this.rows.length)}`);
  }
}

const CONFIRM_TIMEOUT_MS = 180_000;

/** The wallet's unresolved transfer and the database clock, as the repository would read them. */
function transferAt(id: string, createdAt: Date): StoredTransfer {
  return {
    id,
    purpose: 'ORDER',
    attemptId: null,
    network: 'testnet',
    walletAddress: `0:${'0'.repeat(64)}`,
    seqno: 0,
    validUntil: createdAt,
    toAddress: `0:${'1'.repeat(64)}`,
    amountNanoTon: 1n,
    payloadHash: '2'.repeat(64),
    extMsgHash: '3'.repeat(64),
    status: 'SIGNED',
    txHash: null,
    createdAt,
  };
}

class Transfers implements Pick<TonTransferRepository, 'findUnresolved' | 'databaseNowMs'> {
  unresolved: StoredTransfer | null = null;
  dbNowMs = Date.now();

  findUnresolved(): Promise<StoredTransfer | null> {
    return Promise.resolve(this.unresolved);
  }

  databaseNowMs(): Promise<number> {
    return Promise.resolve(this.dbNowMs);
  }
}

class Notices extends TonNotifier {
  readonly sent: TonNotice[] = [];

  constructor() {
    super({ add: () => Promise.resolve() });
  }

  override send(notices: readonly TonNotice[]): Promise<void> {
    this.sent.push(...notices);
    return Promise.resolve();
  }
}

function setup(dryRun = false) {
  const wallet = dryRunTonWallet('testnet');
  const gateway = new FakeTonGateway({ production: false, dryRun: true });
  gateway.registerWallet(wallet, THRESHOLD);
  const snapshots = new Snapshots();
  const notices = new Notices();
  const config = dryRun
    ? buildTestEnv()
    : buildTestEnv({ ...tonLiveSource(), FULFILLMENT_DRY_RUN: 'false' });
  const transfers = new Transfers();
  const monitor = new TonBalanceMonitor(snapshots, notices, gateway, wallet, config, transfers, {
    confirmTimeoutMs: CONFIRM_TIMEOUT_MS,
  });
  return { wallet, gateway, snapshots, notices, monitor, transfers };
}

describe('TonBalanceMonitor', () => {
  let errors: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('records every reading; alerts when low, then only every 6 h while it stays low', async () => {
    const { wallet, gateway, snapshots, notices, monitor } = setup();
    expect(await monitor.tick(0)).toBe('OK');
    gateway.setBalance(wallet.address, THRESHOLD - 1n);
    expect(await monitor.tick(1_000)).toBe('ALERTED');
    expect(notices.sent).toEqual([{ kind: 'ALERT', alert: 'tonLowBalance', refId: 'snap2' }]);
    expect(await monitor.tick(1_000 + LOW_BALANCE_REPEAT_MS - 1)).toBe('LOW');
    expect(await monitor.tick(1_000 + LOW_BALANCE_REPEAT_MS)).toBe('ALERTED');
    gateway.setBalance(wallet.address, THRESHOLD);
    expect(await monitor.tick(2 * LOW_BALANCE_REPEAT_MS)).toBe('OK');
    gateway.setBalance(wallet.address, 1n);
    expect(await monitor.tick(2 * LOW_BALANCE_REPEAT_MS + 1)).toBe('ALERTED');
    expect(snapshots.rows).toHaveLength(6);
    expect(snapshots.rows[1]).toEqual({
      network: 'testnet',
      address: wallet.rawAddress,
      nanoTon: THRESHOLD - 1n,
    });
  });

  it('a failed reading is logged and retried on the next tick; overlapping ticks are skipped', async () => {
    const { gateway, snapshots, monitor } = setup();
    gateway.failNext('getBalance', 1, 'NETWORK');
    expect(await monitor.tick()).toBe('FAILED');
    snapshots.failing = true;
    expect(await monitor.tick()).toBe('FAILED');
    snapshots.failing = false;
    // Logged by error kind only: no address, balance or key material in the line.
    expect(errors.mock.calls).toEqual([
      ['ton balance reading failed (TonGatewayError)'],
      ['ton balance reading failed (Error)'],
    ]);
    const first = monitor.tick();
    expect(await monitor.tick()).toBe('BUSY');
    expect(await first).toBe('OK');
  });

  it('an unresolved transfer older than TON_CONFIRM_TIMEOUT_MS: tonWalletBlocked, by the database clock', async () => {
    const { notices, monitor, transfers } = setup();
    transfers.dbNowMs = 10_000_000;
    transfers.unresolved = transferAt('tr9', new Date(10_000_000 - CONFIRM_TIMEOUT_MS));
    expect(await monitor.checkBlocked()).toBeNull();
    transfers.unresolved = transferAt('tr9', new Date(10_000_000 - CONFIRM_TIMEOUT_MS - 1));
    expect(await monitor.checkBlocked()).toBe('tr9');
    expect(await monitor.tick()).toBe('OK');
    // Raised on every look; the notify job id (alert-tonWalletBlocked-tr9) drops the repeats.
    expect(notices.sent).toEqual([
      { kind: 'ALERT', alert: 'tonWalletBlocked', refId: 'tr9' },
      { kind: 'ALERT', alert: 'tonWalletBlocked', refId: 'tr9' },
    ]);
    transfers.unresolved = null;
    expect(await monitor.checkBlocked()).toBeNull();
  });

  it('the boot clock check: the database clock within 30 s of ours', async () => {
    const { monitor, transfers } = setup();
    transfers.dbNowMs = Date.now() + 29_000;
    expect(await monitor.checkClock()).toBe(true);
    transfers.dbNowMs = Date.now() + 31_000;
    expect(await monitor.checkClock()).toBe(false);
    const last = errors.mock.calls.at(-1) as unknown[] | undefined;
    expect(last?.[0]).toMatch(/^the database clock is \d+ ms off ours/);
  });

  it('never starts in a dry run; stops with the module', async () => {
    const dry = setup(true);
    dry.monitor.onApplicationBootstrap();
    await dry.monitor.onModuleDestroy();
    expect(dry.gateway.callCount('getBalance')).toBe(0);
    const live = setup();
    live.monitor.onApplicationBootstrap();
    await live.monitor.onModuleDestroy();
    expect(live.gateway.callCount('getBalance')).toBe(1);
  });
});
