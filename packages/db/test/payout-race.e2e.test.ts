import { Client, type QueryConfig } from 'pg';
import { describe, expect, it } from 'vitest';
import { requireTestDatabaseUrl } from './db-guard';
import { db } from './client';
import { addAttempt, paidOrder } from './order-fixtures';

// Audit N1 / review R1: a payout that appears AFTER an operator failed and refunded the order
// (a stalled worker waking up, a duplicate job) must be refused, in either order of arrival.
// Two separate connections: one holds its transaction open while the other waits for it, which is
// what READ COMMITTED does to two real transactions. The INSERT guards take FOR SHARE on the rows
// whose state they test; the UPDATE of a status needs the opposite lock, so one side waits for the
// other to commit and then sees what it did. Every wait has a timeout: a lost race must fail the
// test, never hang it.

const WAIT_MS = 10_000;
const TEST_MS = 30_000;

async function connect(): Promise<Client> {
  const client = new Client({
    connectionString: requireTestDatabaseUrl(process.env['DATABASE_URL']),
  });
  await client.connect();
  await client.query(`SET lock_timeout = '${WAIT_MS}ms'`);
  await client.query(`SET statement_timeout = '${WAIT_MS * 2}ms'`);
  return client;
}

async function backendPid(client: Client): Promise<number> {
  const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const row = result.rows[0];
  if (row === undefined) throw new Error('no backend pid');
  return row.pid;
}

/** Polls until the backend `pid` is blocked on a lock held by another transaction. */
async function waitUntilBlocked(pid: number): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_stat_activity WHERE pid = ${pid} AND wait_event_type = 'Lock'`;
    if ((rows[0]?.n ?? 0n) > 0n) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`backend ${pid} never waited for a lock`);
}

/** Runs the scenario with two connections and always releases them. */
async function withTwo(run: (first: Client, second: Client, secondPid: number) => Promise<void>) {
  const first = await connect();
  const second = await connect();
  try {
    await first.query('BEGIN');
    await second.query('BEGIN');
    await run(first, second, await backendPid(second));
  } finally {
    await first.query('ROLLBACK').catch(() => undefined);
    await second.query('ROLLBACK').catch(() => undefined);
    await first.end();
    await second.end();
  }
}

// The refusal handler is attached when the statement is sent: the refusal can arrive while the test
// still awaits COMMIT on the other connection, and a handler attached after that counts as unhandled.
const refusalOf = (statement: Promise<unknown>): Promise<unknown> =>
  statement.then(
    () => undefined,
    (e: unknown) => e,
  );

const sqlstateOf = async (
  pending: Promise<unknown>,
): Promise<{ code: unknown; message: string }> => {
  const error: unknown = await pending;
  expect(error, 'the waiting statement must be refused').toBeInstanceOf(Error);
  const e = error as { code?: unknown; message: string };
  return { code: e.code, message: e.message };
};

const failOrder = (orderId: string): QueryConfig => ({
  text: `UPDATE "Order" SET "status" = 'FAILED', "statusReason" = 'RECIPIENT_GONE' WHERE "id" = $1`,
  values: [orderId],
});

const insertAttempt = (orderId: string): QueryConfig => ({
  text: `INSERT INTO "FulfillmentAttempt" ("id", "orderId", "attemptNo", "adapter", "status", "request", "updatedAt")
    VALUES ('race-attempt-' || $1::text, $1::text, 1, 'FRAGMENT', 'SENDING', '{}', now())`,
  values: [orderId],
});

const insertTransfer = (attemptId: string): QueryConfig => ({
  text: `INSERT INTO "TonTransfer" ("id", "purpose", "attemptId", "network", "walletAddress", "seqno", "validUntil",
      "toAddress", "amountNanoTon", "payloadHash", "extMsgHash", "bocBase64", "status", "updatedAt")
    VALUES ('race-transfer-' || $1::text, 'ORDER', $1::text, 'mainnet', '0:' || repeat('a', 64), 41,
      now() + interval '1 minute', '0:' || repeat('c', 64), 235000000, repeat('d', 64), repeat('e', 64),
      'te6cc', 'SIGNED', now())`,
  values: [attemptId],
});

describe('an operator fails the order while a payout is being created (N1)', () => {
  it(
    '(a) the order is failed first, the attempt INSERT waits and is then refused',
    async () => {
      const { order } = await paidOrder('PROCESSING');
      await withTwo(async (operator, worker, workerPid) => {
        await operator.query(failOrder(order.id));
        const pending = refusalOf(worker.query(insertAttempt(order.id)));
        await waitUntilBlocked(workerPid);
        await operator.query('COMMIT');
        const refused = await sqlstateOf(pending);
        expect(refused.code).toBe('GG001');
        expect(refused.message).toContain('PROCESSING');
      });
      expect(await db.fulfillmentAttempt.count({ where: { orderId: order.id } })).toBe(0);
      expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('FAILED');
    },
    TEST_MS,
  );

  it(
    '(a) the attempt is closed and the order failed, the transfer INSERT waits and is then refused',
    async () => {
      const { order } = await paidOrder('PROCESSING');
      const attempt = await addAttempt(order.id, 'SENDING');
      await withTwo(async (operator, worker, workerPid) => {
        await operator.query(
          `UPDATE "FulfillmentAttempt" SET "status" = 'FAILED' WHERE "id" = $1`,
          [attempt.id],
        );
        await operator.query(failOrder(order.id));
        const pending = refusalOf(worker.query(insertTransfer(attempt.id)));
        await waitUntilBlocked(workerPid);
        await operator.query('COMMIT');
        const refused = await sqlstateOf(pending);
        expect(refused.code).toBe('GG001');
        expect(refused.message).toContain('PROCESSING');
      });
      expect(await db.tonTransfer.count()).toBe(0);
    },
    TEST_MS,
  );

  it(
    '(a) only the attempt is closed: the transfer INSERT waits on the attempt and is refused',
    async () => {
      const { order } = await paidOrder('PROCESSING');
      const attempt = await addAttempt(order.id, 'SENDING');
      await withTwo(async (operator, worker, workerPid) => {
        await operator.query(
          `UPDATE "FulfillmentAttempt" SET "status" = 'FAILED' WHERE "id" = $1`,
          [attempt.id],
        );
        const pending = refusalOf(worker.query(insertTransfer(attempt.id)));
        await waitUntilBlocked(workerPid);
        await operator.query('COMMIT');
        const refused = await sqlstateOf(pending);
        expect(refused.code).toBe('GG001');
        expect(refused.message).toContain('SENDING');
      });
      expect(await db.tonTransfer.count()).toBe(0);
    },
    TEST_MS,
  );

  it(
    '(b) the attempt is created first, the order FAILED waits and is then refused',
    async () => {
      const { order } = await paidOrder('PROCESSING');
      await withTwo(async (worker, operator, operatorPid) => {
        await worker.query(insertAttempt(order.id));
        const pending = refusalOf(operator.query(failOrder(order.id)));
        await waitUntilBlocked(operatorPid);
        await worker.query('COMMIT');
        const refused = await sqlstateOf(pending);
        expect(refused.code).toBe('GG001');
        expect(refused.message).toContain('may have gone out');
      });
      expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
        'PROCESSING',
      );
      expect(await db.fulfillmentAttempt.count({ where: { orderId: order.id } })).toBe(1);
    },
    TEST_MS,
  );

  it(
    '(b) the transfer is signed first, the attempt FAILED waits and is then refused',
    async () => {
      const { order } = await paidOrder('PROCESSING');
      const attempt = await addAttempt(order.id, 'SENDING');
      await withTwo(async (worker, operator, operatorPid) => {
        await worker.query(insertTransfer(attempt.id));
        const pending = refusalOf(
          operator.query(`UPDATE "FulfillmentAttempt" SET "status" = 'FAILED' WHERE "id" = $1`, [
            attempt.id,
          ]),
        );
        await waitUntilBlocked(operatorPid);
        await worker.query('COMMIT');
        const refused = await sqlstateOf(pending);
        expect(refused.code).toBe('GG001');
        expect(refused.message).toContain('cannot fail');
      });
      expect(
        (await db.fulfillmentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status,
      ).toBe('SENDING');
    },
    TEST_MS,
  );

  it(
    // The wait is on the locks the worker's transfer INSERT holds (order and attempt rows); what the
    // order guard then refuses on is the SENDING attempt AND the transfer together. A legal state with a
    // live transfer and no live attempt cannot be built, so the transfer's own contribution is proved
    // in payout-race-helpers.e2e.test.ts ("I5"), with rows forced in.
    '(b) the transfer is signed first, the order FAILED waits and is then refused (attempt + transfer)',
    async () => {
      const { order } = await paidOrder('PROCESSING');
      const attempt = await addAttempt(order.id, 'SENDING');
      await withTwo(async (worker, operator, operatorPid) => {
        await worker.query(insertTransfer(attempt.id));
        const pending = refusalOf(operator.query(failOrder(order.id)));
        await waitUntilBlocked(operatorPid);
        await worker.query('COMMIT');
        const refused = await sqlstateOf(pending);
        expect(refused.code).toBe('GG001');
        expect(refused.message).toContain('may have gone out');
      });
      expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
        'PROCESSING',
      );
      expect(await db.tonTransfer.count({ where: { attemptId: attempt.id } })).toBe(1);
    },
    TEST_MS,
  );
});
