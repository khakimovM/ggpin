import { existsSync } from 'node:fs';
import path from 'node:path';
import { E2E_BOT_TOKEN } from '../fixtures/telegram';
import { E2E_BOT_USERNAME } from './app-env';
import { e2eDatabase } from './db-guard';
import { connectE2eClient, minimalEnv } from './real-db';
import { REDIS_URL } from './real-env';
import { clearTelegramQueues } from './real-queues';
import { guardHits, spawnService, type Service } from './real-process';
import { acquireRealStackLock } from './real-lock';
import { injectGuardHits, startRealWorker } from './real-worker';

// The REAL API (and, when asked, the real worker) for the journeys that must see real server
// behaviour (the `real-api` project). The API runs from the built `apps/api/dist`, on its own database and Redis DB number, with the bot switched off
// (`TELEGRAM_BOT_MODE=off`) and a synthetic bot token, so no request ever goes to api.telegram.org.
// Nothing here relaxes the API's own env checks: the values below simply satisfy them.

export const API_PORT = 5000; // the web build's NEXT_PUBLIC_API_URL (and its CSP) point here
export const API_BASE = `http://localhost:${API_PORT}/api/v1`;

const API_DIR = path.resolve(__dirname, '../../../api');

function apiEnv(databaseUrl: string): NodeJS.ProcessEnv {
  return {
    ...minimalEnv(),
    NODE_ENV: 'development',
    API_PORT: String(API_PORT),
    DATABASE_URL: databaseUrl,
    REDIS_URL,
    WEB_URL: 'http://localhost:3100',
    ADMIN_URL: 'http://localhost:5173',
    LOG_LEVEL: 'warn',
    // Synthetic and mutually different, as the API demands; none is a real credential.
    JWT_ACCESS_SECRET: 'e2e-synthetic-access-secret-0123456789abcdef',
    JWT_REFRESH_SECRET: 'e2e-synthetic-refresh-secret-0123456789abcde',
    TG_SESSION_SECRET: 'e2e-synthetic-session-secret-0123456789abcd',
    OTP_PEPPER: 'e2e-synthetic-otp-pepper-0123456789abcdefgh',
    PAY_TOKEN_PEPPER: 'e2e-synthetic-pay-token-pepper-0123456789abcd',
    TELEGRAM_BOT_TOKEN: E2E_BOT_TOKEN,
    TELEGRAM_BOT_USERNAME: E2E_BOT_USERNAME,
    TELEGRAM_BOT_MODE: 'off',
  };
}

async function isUp(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/health/live`);
    return response.ok;
  } catch {
    return false;
  }
}

export interface RunningApi {
  stop: () => Promise<void>;
  /** Connections the loopback guard refused, in the API and the worker. Empty: all stayed local. */
  guardHits: () => string[];
  /** Everything the API wrote, for a failure message (never printed otherwise). */
  apiOutput: () => string;
}

export interface StartOptions {
  /** Also start the worker (BANK_FEED_MODE=fake, dry run), the way the top-up journeys need it. */
  worker?: boolean;
}

/**
 * Starts the real API (and the worker when asked). The stack exists once per machine: this waits
 * for the other spec files of the project to stop theirs (real-lock.ts) and frees the lock in
 * `stop`, or at once when the start fails.
 */
export async function startRealApi(options: StartOptions = {}): Promise<RunningApi> {
  const entry = path.join(API_DIR, 'dist', 'main.js');
  if (!existsSync(entry)) {
    throw new Error(
      'apps/api/dist/main.js is missing: build the API first (npm run build -w api).',
    );
  }
  const release = await acquireRealStackLock();
  const started: Service[] = [];
  try {
    // Whatever answers on this port is somebody else's API, possibly on a different database.
    if (await isUp()) {
      throw new Error(`Port ${API_PORT} is already served by another API; stop it and run again.`);
    }
    // Nothing consumes the notify and tg-outbox queues with the bot off: what an earlier run left
    // there would otherwise be sent by a later one that has a bot (and Redis DB 13 grows for ever).
    await clearTelegramQueues();
    const api = spawnService('api', entry, API_DIR, apiEnv(e2eDatabase().url));
    started.push(api);
    const deadline = Date.now() + 60_000;
    while (!(await isUp())) {
      if (api.exited() || Date.now() > deadline) {
        throw new Error(`The API did not start.\n${api.output().slice(-2000)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    // Somebody else may have taken the port between the check above and our start: our process then
    // dies, yet the loop saw THEIR API answer. An API that is not ours must not count as started.
    if (api.exited()) {
      throw new Error(
        `Port ${API_PORT} is answered by a process that is not the API started here (ours exited).\n${api.output().slice(-2000)}`,
      );
    }
    if (options.worker === true) started.push(await startRealWorker());
    // A process the guard did not announce itself in was not guarded: nothing would be proved.
    for (const service of started) {
      if (!service.guardActive())
        throw new Error(`${service.name} started without the loopback guard.`);
    }
    return {
      stop: async () => {
        try {
          // The worker first: it writes to the database the API reads.
          for (const service of [...started].reverse()) await service.stop();
          // The jobs this run queued for a bot that is off; the stack is stopped, nobody writes more.
          await clearTelegramQueues();
        } finally {
          release();
        }
      },
      guardHits: () => [...guardHits(...started), ...injectGuardHits()],
      apiOutput: () => api.output(),
    };
  } catch (error) {
    try {
      for (const service of started) await service.stop();
    } finally {
      release();
    }
    throw error;
  }
}

/** One value from the e2e database. Parameters are bound, never interpolated. */
export async function dbValue<T = string | null>(
  sql: string,
  params: unknown[],
): Promise<T | null> {
  const client = await connectE2eClient();
  try {
    const result = await client.query<Record<string, T>>(sql, params);
    const row = result.rows[0];
    return row === undefined ? null : (Object.values(row)[0] ?? null);
  } finally {
    await client.end();
  }
}
