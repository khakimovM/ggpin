import { lockTopupCard } from '@repo/db';
import { DEFAULT_CARD_LOCK_TIMING } from '../card-lock-timing';
import { usePaymentsE2e } from './payments-e2e.helpers';

// R-3: a card whose lock somebody else holds. The request waits at most lockWaitMs (3 s) for
// it, gets 55P03, has no other card, and answers 503: quickly, and without writing anything.
const e2e = usePaymentsE2e();

describe('POST /payments/intents on a busy card', () => {
  it('the card lock held in another transaction: 503 within 5 s, no new row', async () => {
    const card = await e2e.card();
    const user = await e2e.newUser();
    const { status, elapsedMs } = await e2e.db().$transaction(
      async (tx) => {
        // The wait is timed on Postgres' own clock, the one lock_timeout runs on: the Docker VM's
        // clock drifts from the host's by more than the tolerance (a "3 s" wait once read 2856 ms
        // on Date.now()). clock_timestamp() is wall time, not the transaction's start time.
        const dbClockMs = async (): Promise<number> => {
          const rows = await tx.$queryRaw<{ ms: number }[]>`
            SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms`;
          const row = rows[0];
          if (row === undefined) throw new Error('clock_timestamp() returned no row');
          return row.ms;
        };
        await lockTopupCard(tx, card.id);
        const started = await dbClockMs();
        const res = await e2e.create(user);
        return { status: res.status, elapsedMs: (await dbClockMs()) - started };
      },
      { timeout: 20_000 },
    );
    expect(status).toBe(503);
    // It did wait for the lock (so the 503 is the lock's), but not past the bound.
    expect(elapsedMs).toBeGreaterThanOrEqual(DEFAULT_CARD_LOCK_TIMING.lockWaitMs - 100);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(await e2e.db().paymentIntent.count({ where: { userId: user.id } })).toBe(0);

    // Lock released (the transaction above has ended): the same request now goes through.
    expect((await e2e.create(user)).status).toBe(201);
  }, 30_000);
});
