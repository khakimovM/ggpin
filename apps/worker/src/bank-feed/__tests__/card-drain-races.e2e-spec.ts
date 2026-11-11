import { lockTopupCard } from '@repo/db';
import { QUEUES, reservedUntilWhenPaid } from '@repo/shared';
import { Queue } from 'bullmq';
import {
  bootReconcileWorker,
  type ReconcileWorker,
} from '../../reconcile/__tests__/reconcile-e2e.harness';
import { CARD_DRAINED_ALERT_RETRY_MS, CardDrainService } from '../card-drain.service';
import {
  drainAudits,
  drainedAlertId,
  endedForDrain,
  intentEndingAt,
} from './card-drain.e2e-helpers';
import { useMatcherE2e } from './matcher-e2e.harness';
import { MINUTE, createCard } from './matcher-e2e.fixtures';
import { waitForBlockedSession } from './test-seams';

// The DRAINING -> RETIRED sweep against concurrent writers on the real ggpin_test DB: the
// re-check under the card lock, a busy card lock (55P03) and the recovery of a lost alert.
const t = useMatcherE2e();
let w: ReconcileWorker;
let drain: CardDrainService;
let notify: Queue;

beforeAll(async () => {
  w = await bootReconcileWorker(t.env);
  drain = w.moduleRef.get(CardDrainService);
  notify = new Queue(QUEUES.NOTIFY, { connection: { url: t.env.REDIS_URL } });
});

afterAll(async () => {
  await notify.close();
  await w.close();
});

const cardOf = (id: string) => t.db.topupCard.findUniqueOrThrow({ where: { id } });

describe('card drain: races and recovery', () => {
  it('I7: a payment credited while the sweep waits for the card lock keeps the card DRAINING', async () => {
    const card = await createCard(t.db, { status: 'DRAINING' });
    const intent = await intentEndingAt(t.db, card.id, 'EXPIRED', endedForDrain());
    const until = intent.reservedUntil;
    if (until === null) throw new Error('a P2P request always has reservedUntil');
    let sweep: ReturnType<CardDrainService['run']> | undefined;

    // Another writer (standing for the matcher's credit) holds the card lock first. The sweep
    // reads the card as a candidate (no lock), then waits; the writer extends the reservation
    // (EXPIRED -> PAID inside its grace) and commits; only then does the sweep get the lock.
    await t.db.$transaction(
      async (tx) => {
        await lockTopupCard(tx, card.id);
        sweep = drain.run(new Date());
        await waitForBlockedSession(tx, 'advisory');
        const paidAt = new Date(until.getTime() - MINUTE);
        await tx.paymentIntent.update({
          where: { id: intent.id },
          data: {
            status: 'PAID',
            paidAt,
            reservedUntil: reservedUntilWhenPaid(
              { expiresAt: intent.expiresAt, reservedUntil: until },
              paidAt,
            ),
          },
        });
      },
      { timeout: 15_000 },
    );
    const result = await sweep;
    expect(result?.skipped).toBe(0);
    const after = await cardOf(card.id);
    expect(after.status).toBe('DRAINING');
    expect(after.retiredAt).toBeNull();
    expect(await drainAudits(t.db, card.id)).toHaveLength(0);
  });

  it('a card lock held longer than lock_timeout: 55P03, the card is skipped and unchanged', async () => {
    const card = await createCard(t.db, { status: 'DRAINING' });
    await intentEndingAt(t.db, card.id, 'CANCELLED', endedForDrain());
    const result = await t.db.$transaction(
      async (tx) => {
        await lockTopupCard(tx, card.id);
        return drain.run(new Date());
      },
      { timeout: t.env.BANK_FEED_LOCK_TIMEOUT_MS + 10_000 },
    );
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect((await cardOf(card.id)).status).toBe('DRAINING');
    expect(await drainAudits(t.db, card.id)).toHaveLength(0);

    // Lock released: the next run retires it.
    await drain.run(new Date());
    expect((await cardOf(card.id)).status).toBe('RETIRED');
  });

  it('a lost cardDrained job is queued again by the next runs, only inside the retry window', async () => {
    const card = await createCard(t.db, { status: 'DRAINING' });
    await intentEndingAt(t.db, card.id, 'EXPIRED', endedForDrain());
    const now = new Date();
    await drain.run(now);
    expect((await cardOf(card.id)).status).toBe('RETIRED');
    const jobId = drainedAlertId(card.id);
    const lost = async () => {
      await (await notify.getJob(jobId))?.remove();
      expect(await notify.getJob(jobId)).toBeUndefined();
    };

    // The job was lost after the commit (Redis trouble): the next run finds the card by its audit.
    await lost();
    const again = await drain.run(new Date(now.getTime() + MINUTE));
    expect(again.retired).toBe(0);
    expect((await t.notifyJob(jobId))?.data).toEqual({
      kind: 'OWNER_ALERT',
      alert: 'cardDrained',
      refId: card.id,
    });

    // After the window the retirement is old news: nothing is queued again. NOTE: this run is
    // global (every DRAINING card in the shared test DB); the file runs in band, and the cards of
    // the tests above are already settled, so it only re-checks this card's alert.
    await lost();
    await drain.run(new Date(Date.now() + CARD_DRAINED_ALERT_RETRY_MS + MINUTE));
    expect(await notify.getJob(jobId)).toBeUndefined();
  });
});
