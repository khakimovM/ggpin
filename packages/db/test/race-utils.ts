import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import type { Tx } from '../src/index';
import { requireTestDatabaseUrl } from './db-guard';
import { db } from './client';

// Helpers of the race tests: two real connections (one holds its transaction open while the other
// waits for it, which is what READ COMMITTED does to two real transactions) and a Prisma transaction
// that is kept open after its work. Every wait has a timeout: a lost race must fail the test, never
// hang it.

export const WAIT_MS = 10_000;
export const TEST_MS = 40_000;

export async function connect(): Promise<Client> {
  const client = new Client({
    connectionString: requireTestDatabaseUrl(process.env['DATABASE_URL']),
  });
  await client.connect();
  await client.query(`SET lock_timeout = '${WAIT_MS}ms'`);
  await client.query(`SET statement_timeout = '${WAIT_MS * 2}ms'`);
  return client;
}

export async function pidOf(client: Client): Promise<number> {
  const row = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0];
  if (row === undefined) throw new Error('no backend pid');
  return row.pid;
}

export async function waitUntilBlocked(pid: number): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_stat_activity WHERE pid = ${pid} AND wait_event_type = 'Lock'`;
    if ((rows[0]?.n ?? 0n) > 0n) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`backend ${pid} never waited for a lock`);
}

/** Any backend of this database (other than `except`) that waits on a lock. */
export async function waitUntilAnyBlocked(except: number): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> ${except}`;
    if ((rows[0]?.n ?? 0n) > 0n) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('no backend ever waited for a lock');
}

/**
 * Runs `work` in a Prisma transaction and keeps it OPEN after `work` returns, until `release()`.
 * `ready` resolves when `work` has finished (successfully or not); `done` is the transaction's end.
 */
export function heldTransaction<T>(work: (tx: Tx) => Promise<T>) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: () => void = () => undefined;
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const done = db
    .$transaction(
      async (tx) => {
        let failure: Error | undefined;
        let value: T | undefined;
        try {
          value = await work(tx);
        } catch (error) {
          failure =
            error instanceof Error ? error : new Error('the work of the held transaction failed');
        }
        ready();
        await gate;
        if (failure !== undefined) throw failure;
        return value;
      },
      { timeout: 60_000, maxWait: 30_000 },
    )
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  return { release, ready: readyPromise, done };
}

export const hex = (): string => randomBytes(32).toString('hex');
