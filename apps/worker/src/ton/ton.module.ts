import { Module } from '@nestjs/common';
import { RedisLockStore } from '../bank-feed/client/leader-lock';
import { WORKER_CONFIG, type WorkerConfig } from '../config/config.module';
import { RedisService } from '../infra/redis/redis.service';
import { TonBalanceMonitor } from './ton-balance.monitor';
import { TonChainReader } from './ton-chain-reader';
import { TonConfirmService } from './ton-confirm.service';
import {
  buildTonGateway,
  buildTonWallet,
  hotWalletAddressOf,
  tonExpiryWitnessesOf,
  tonPayAddressesOf,
  tonTimingOf,
} from './ton-factories';
import type { TonGateway } from './ton-gateway';
import { TonWalletLock } from './ton-lock';
import { TonNotifier } from './ton-notifier';
import { TonOutcomeRepository } from './ton-outcome.repository';
import { TonSenderService } from './ton-sender.service';
import { TonSnapshotRepository } from './ton-snapshot.repository';
import {
  NO_SENDER_HOOKS,
  TON_EXPIRY_WITNESSES,
  TON_GATEWAY,
  TON_HOT_WALLET_ADDRESS,
  TON_PAY_ADDRESSES,
  TON_SENDER_HOOKS,
  TON_TIMING,
  TON_WALLET,
  TON_WALLET_LOCK,
  TON_WALLET_LOCK_KEY,
  type TonHotWalletAddress,
  type TonPayAddresses,
  type TonTiming,
} from './ton-tokens';
import { TonTransferRepository } from './ton-transfer.repository';
import type { TonWallet } from './ton-wallet';

// The TON payout module (phase 5 S5). The only place in the system that holds the hot wallet's key
// (CLAUDE.md §5.7). Consumers (fulfill-order, S4/S8) use TonSenderService.pay and, for the
// reconciler (S9), TonConfirmService; the wallet's address is exported, its signer is not (audit
// L1). Prisma, Redis and the notify queue come from the worker's global modules.
@Module({
  providers: [
    {
      provide: TON_WALLET,
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig) => buildTonWallet(config),
    },
    {
      provide: TON_HOT_WALLET_ADDRESS,
      inject: [TON_WALLET],
      useFactory: (wallet: TonWallet): TonHotWalletAddress => hotWalletAddressOf(wallet),
    },
    {
      provide: TON_GATEWAY,
      inject: [WORKER_CONFIG, TON_WALLET],
      useFactory: (config: WorkerConfig, wallet: TonWallet): TonGateway =>
        buildTonGateway(config, wallet),
    },
    {
      provide: TON_TIMING,
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig): TonTiming => tonTimingOf(config),
    },
    {
      provide: TON_PAY_ADDRESSES,
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig): TonPayAddresses => tonPayAddressesOf(config),
    },
    { provide: TON_EXPIRY_WITNESSES, useFactory: tonExpiryWitnessesOf },
    { provide: TON_SENDER_HOOKS, useValue: NO_SENDER_HOOKS },
    {
      provide: TON_WALLET_LOCK,
      inject: [RedisService, TON_TIMING],
      useFactory: (redis: RedisService, timing: TonTiming) =>
        new TonWalletLock(new RedisLockStore(redis.client), TON_WALLET_LOCK_KEY, timing.lockTtlMs),
    },
    TonTransferRepository,
    TonOutcomeRepository,
    TonSnapshotRepository,
    TonChainReader,
    TonNotifier,
    TonConfirmService,
    TonSenderService,
    TonBalanceMonitor,
  ],
  // TON_PAY_ADDRESSES: the fulfillment core checks a prepared payee before SENDING (S4 audit L-4).
  exports: [TonSenderService, TonConfirmService, TON_HOT_WALLET_ADDRESS, TON_PAY_ADDRESSES],
})
export class TonModule {}
