import { existsSync } from 'node:fs';
import path from 'node:path';
import { tiyinToSom } from '@repo/shared';
import { e2eDatabase } from './db-guard';
import { minimalEnv } from './real-db';
import { REDIS_URL } from './real-env';
import { runToEnd, spawnService, type Service } from './real-process';

// The REAL worker of the journeys (phase 7 S12-a): the built `apps/worker/dist`, on the e2e database
// and Redis DB 13, with BANK_FEED_MODE=fake (the in-memory bank client: no Telegram session, no
// bank) and FULFILLMENT_DRY_RUN=true. It never gets a bot token (the worker refuses one), so its
// owner alerts and notifications only go to Redis queues that the API, started with the bot off,
// does not consume. Every process here also runs under the loopback guard (loopback-only.cjs).

const WORKER_DIR = path.resolve(__dirname, '../../../worker');
// Synthetic bot ids, two different ones: the matcher and the inject tool pin messages to them.
const HUMO_BOT_ID = '900000000001';
const UZCARD_BOT_ID = '900000000002';

function workerEnv(): NodeJS.ProcessEnv {
  return {
    ...minimalEnv(),
    NODE_ENV: 'development',
    DATABASE_URL: e2eDatabase().url,
    REDIS_URL,
    LOG_LEVEL: 'info',
    FULFILLMENT_DRY_RUN: 'true',
    BANK_FEED_MODE: 'fake',
    BANK_FEED_HUMO_BOT_ID: HUMO_BOT_ID,
    BANK_FEED_UZCARD_BOT_ID: UZCARD_BOT_ID,
    // The fastest the worker allows: the API reads the listener's heartbeat to hand out requests.
    BANK_FEED_POLL_SEC: '5',
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startRealWorker(): Promise<Service> {
  const entry = path.join(WORKER_DIR, 'dist', 'main.js');
  if (!existsSync(entry)) {
    throw new Error(
      'apps/worker/dist/main.js is missing: build it first (npm run build -w worker).',
    );
  }
  const worker = spawnService('worker', entry, WORKER_DIR, workerEnv());
  const deadline = Date.now() + 60_000;
  while (!worker.output().includes('worker started')) {
    if (worker.exited() || Date.now() > deadline) {
      await worker.stop();
      throw new Error(`The worker did not start.\n${worker.output().slice(-2000)}`);
    }
    await sleep(300);
  }
  return worker;
}

/** Guard hits of the inject runs (each is a process of its own, gone when it ends). */
const injectHits: string[] = [];
export const injectGuardHits = (): string[] => [...injectHits];

export type BankName = 'HUMO' | 'UZCARD';

/**
 * One synthetic bank notification through the ordinary ingest path (`bank-feed:inject`, the tool of
 * docs/05 `BANK_FEED_MODE=fake`): it is stored, a `bank-message` job is queued, and the running
 * worker matches it. `payAmountTiyin` is what the request asks to transfer, to the tiyin.
 */
export async function injectBankMessage(input: {
  bank: BankName;
  payAmountTiyin: string;
  last4: string;
}): Promise<string> {
  const entry = path.join(WORKER_DIR, 'dist', 'cli', 'bank-feed-inject.js');
  if (!existsSync(entry)) throw new Error('apps/worker/dist/cli/bank-feed-inject.js is missing.');
  const result = await runToEnd('bank-feed-inject', entry, WORKER_DIR, workerEnv(), [
    '--source',
    input.bank === 'HUMO' ? 'humo' : 'uzcard',
    '--amount',
    tiyinToSom(BigInt(input.payAmountTiyin)),
    '--last4',
    input.last4,
  ]);
  if (result.code !== 0) {
    throw new Error(`bank-feed-inject failed (exit ${String(result.code)}):\n${result.output}`);
  }
  injectHits.push(...result.guardHits);
  if (!result.guardActive) throw new Error('bank-feed-inject ran without the loopback guard.');
  if (result.guardHits.length > 0) {
    throw new Error(`bank-feed-inject tried to leave this machine: ${result.guardHits.join('; ')}`);
  }
  const stored = result.output.split(/\r?\n/).find((line) => line.startsWith('stored '));
  if (stored === undefined) throw new Error(`bank-feed-inject stored nothing:\n${result.output}`);
  return stored;
}
