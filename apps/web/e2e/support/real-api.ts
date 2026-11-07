import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { E2E_BOT_TOKEN } from '../fixtures/telegram';
import { E2E_BOT_USERNAME } from './app-env';
import { e2eDatabase } from './db-guard';
import { minimalEnv } from './real-db';

// The REAL API for journeys that must see real server behaviour (journey 4). It runs from the
// built `apps/api/dist`, on its own database and Redis DB number, with the bot switched off
// (`TELEGRAM_BOT_MODE=off`) and a synthetic bot token, so no request ever goes to api.telegram.org.
// Nothing here relaxes the API's own env checks: the values below simply satisfy them.

export const API_PORT = 5000; // the web build's NEXT_PUBLIC_API_URL (and its CSP) point here
export const API_BASE = `http://localhost:${API_PORT}/api/v1`;

// Redis DB 13: the backend e2e suites use 15 and the dev API 0.
const REDIS_URL = 'redis://localhost:6379/13';

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
}

export async function startRealApi(): Promise<RunningApi> {
  const entry = path.join(API_DIR, 'dist', 'main.js');
  if (!existsSync(entry)) {
    throw new Error(
      'apps/api/dist/main.js is missing: build the API first (npm run build -w api).',
    );
  }
  // Whatever answers on this port is somebody else's API, possibly on a different database.
  if (await isUp()) {
    throw new Error(`Port ${API_PORT} is already served by another API; stop it and run again.`);
  }

  const child: ChildProcess = spawn(process.execPath, [entry], {
    cwd: API_DIR,
    env: apiEnv(e2eDatabase().url),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  const deadline = Date.now() + 60_000;
  while (!(await isUp())) {
    if (exited || Date.now() > deadline) {
      child.kill();
      throw new Error(`The API did not start.\n${output.slice(-2000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  // Somebody else may have taken the port between the check above and our start: our process then
  // dies, yet the loop saw THEIR API answer. An API that is not ours must not count as started.
  if (exited) {
    throw new Error(
      `Port ${API_PORT} is answered by a process that is not the API started here (ours exited).\n${output.slice(-2000)}`,
    );
  }

  return {
    stop: async () => {
      if (exited) return;
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill();
      });
    },
  };
}

/** One value from the e2e database. Parameters are bound, never interpolated. */
export async function dbValue<T = string | null>(
  sql: string,
  params: unknown[],
): Promise<T | null> {
  const client = new pg.Client({ connectionString: e2eDatabase().url });
  await client.connect();
  try {
    const result = await client.query<Record<string, T>>(sql, params);
    const row = result.rows[0];
    return row === undefined ? null : (Object.values(row)[0] ?? null);
  } finally {
    await client.end();
  }
}
