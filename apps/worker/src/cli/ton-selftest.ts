import { setTimeout as delay } from 'node:timers/promises';
import { createPrismaClient } from '@repo/db';
import { Redis } from 'ioredis';
import { RedisLockStore } from '../bank-feed/client/leader-lock';
import { EnvValidationError, loadProcessEnv } from '../config/env';
import { TonChainReader } from '../ton/ton-chain-reader';
import { TonConfirmService } from '../ton/ton-confirm.service';
import { errorKind } from '../ton/ton-db-errors';
import {
  buildTonGateway,
  buildTonWallet,
  tonExpiryWitnessesOf,
  tonTimingOf,
} from '../ton/ton-factories';
import { TonWalletLock } from '../ton/ton-lock';
import { TonNotifier, type NoticeQueue } from '../ton/ton-notifier';
import { TonOutcomeRepository } from '../ton/ton-outcome.repository';
import { runTonSelftest, selftestRefusal, SelftestRefusedError } from '../ton/ton-selftest-flow';
import { TON_WALLET_LOCK_KEY, signLagMaxSec } from '../ton/ton-tokens';
import { TonSecretError } from '../ton/ton-mnemonic';
import { TonTransferRepository } from '../ton/ton-transfer.repository';
import { TonWalletError } from '../ton/ton-wallet';

// The TESTNET self-test of the TON module (plan S5 CLI, S12 step 1), for the owner, with the
// owner's explicit approval only. Needs the worker's env with TON_NETWORK=testnet,
// FULFILLMENT_DRY_RUN=false and the testnet hot wallet (TON_MNEMONIC_ENC, WALLET_ENC_KEY_FILE,
// TON_WALLET_ADDRESS), plus DATABASE_URL and REDIS_URL:
//   npm run ton:selftest -w worker
// Mainnet, a dry run and NODE_ENV=production are refused before anything is opened. It moves
// 0.01 TON from the hot wallet to the same key's subwallet 1 and records both test transfers as
// SELFTEST rows. Notices (a seqno used by someone else, say) are printed here, not queued.

const printNotices: NoticeQueue = {
  add: (_name, _data, options) => {
    process.stderr.write(`ton-selftest: owner notice ${options.jobId}\n`);
    return Promise.resolve();
  },
};

async function main(): Promise<number> {
  const env = loadProcessEnv();
  const refusal = selftestRefusal(env);
  if (refusal !== null) {
    process.stderr.write(`ton-selftest: ${refusal}\n`);
    return 2;
  }
  const wallet = await buildTonWallet(env);
  const gateway = buildTonGateway(env, wallet);
  const timing = tonTimingOf(env);
  const holder = { client: createPrismaClient(env.DATABASE_URL) };
  const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  const transfers = new TonTransferRepository(holder);
  const confirm = new TonConfirmService(
    transfers,
    new TonOutcomeRepository(holder),
    new TonChainReader(gateway, wallet, timing, tonExpiryWitnessesOf()),
    new TonNotifier(printNotices),
    timing,
  );
  try {
    const report = await runTonSelftest({
      network: env.TON_NETWORK,
      wallet,
      gateway,
      transfers,
      confirm,
      lock: new TonWalletLock(new RedisLockStore(redis), TON_WALLET_LOCK_KEY, timing.lockTtlMs),
      limits: { perOrderMaxNano: env.TON_MAX_PER_ORDER_NANO, dailyMaxNano: env.TON_MAX_DAILY_NANO },
      feeReserveNano: env.TON_FEE_RESERVE_NANO,
      validSec: env.TON_SEND_VALID_SEC,
      maxSignLagSec: signLagMaxSec(timing),
      say: (line) => process.stderr.write(`ton-selftest: ${line}\n`),
      sleep: async (ms) => {
        await delay(ms);
      },
    });
    process.stderr.write(`ton-selftest: ${report.ok ? 'PASSED' : 'FAILED'}\n`);
    return report.ok ? 0 : 1;
  } finally {
    await holder.client.$disconnect();
    redis.disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const readable =
      error instanceof EnvValidationError ||
      error instanceof TonWalletError ||
      error instanceof TonSecretError ||
      error instanceof SelftestRefusedError;
    process.stderr.write(`ton-selftest: ${readable ? error.message : errorKind(error)}\n`);
    process.exit(2);
  },
);
