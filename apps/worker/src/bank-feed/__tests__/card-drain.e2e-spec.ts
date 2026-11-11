import { QUEUES } from '@repo/shared';
import { Queue } from 'bullmq';
import {
  bootReconcileWorker,
  type ReconcileWorker,
} from '../../reconcile/__tests__/reconcile-e2e.harness';
import { CardDrainService } from '../card-drain.service';
import {
  LATE,
  drainAudits,
  drainedAlertId,
  endedForDrain,
  intentEndingAt,
} from './card-drain.e2e-helpers';
import { useMatcherE2e } from './matcher-e2e.harness';
import {
  GRACE_MS,
  HOUR,
  MINUTE,
  createCard,
  createIntent,
  createUser,
  insertMessage,
  uniqueAmount,
} from './matcher-e2e.fixtures';

// DRAINING -> RETIRED (docs/05 §2) on the real ggpin_test DB. The sweep is global by design
// (every DRAINING card), so the assertions name this file's rows only. Races, the busy lock and
// the alert recovery are in card-drain-races.e2e-spec.ts.
const t = useMatcherE2e();
let w: ReconcileWorker;
let drain: CardDrainService;
let notify: Queue;
// `w.expire.run` re-queues undecided messages of the shared DB (S9 m1); nothing consumes the
// `bank-message` queue here, so the jobs it made live are removed again after the file.
const LIVE = ['waiting', 'delayed', 'prioritized', 'paused'] as const;
let liveBefore = new Set<string>();

beforeAll(async () => {
  w = await bootReconcileWorker(t.env);
  drain = w.moduleRef.get(CardDrainService);
  notify = new Queue(QUEUES.NOTIFY, { connection: { url: t.env.REDIS_URL } });
  const jobs = await w.bankMessages.getJobs([...LIVE]);
  liveBefore = new Set(jobs.map((j) => j.id ?? ''));
});

afterAll(async () => {
  for (const job of await w.bankMessages.getJobs([...LIVE])) {
    if (!liveBefore.has(job.id ?? '')) await job.remove();
  }
  await notify.close();
  await w.close();
});

const cardOf = (id: string) => t.db.topupCard.findUniqueOrThrow({ where: { id } });
const audits = (cardId: string) => drainAudits(t.db, cardId);
const drainedAlert = (cardId: string) => t.notifyJob(drainedAlertId(cardId));

describe('card drain: DRAINING -> RETIRED once every reservation ended', () => {
  it('retires a DRAINING card whose requests (every status) ended: retiredAt, SYSTEM audit, one alert', async () => {
    const card = await createCard(t.db, { status: 'DRAINING' });
    for (const status of ['EXPIRED', 'CANCELLED', 'PAID'] as const) {
      await intentEndingAt(t.db, card.id, status, endedForDrain());
    }
    const now = new Date();
    const result = await drain.run(now);
    expect(result.retired).toBeGreaterThanOrEqual(1);

    const after = await cardOf(card.id);
    expect(after.status).toBe('RETIRED');
    expect(after.retiredAt).toEqual(now);
    const [audit, ...more] = await audits(card.id);
    expect(more).toHaveLength(0);
    expect(audit).toMatchObject({
      actorType: 'SYSTEM',
      actorId: null,
      ip: null,
      targetType: 'TopupCard',
      reason: 'RESERVATIONS_ENDED',
      before: { status: 'DRAINING' },
      after: { status: 'RETIRED', retiredAt: now.toISOString() },
    });
    const job = await drainedAlert(card.id);
    expect(job?.data).toEqual({ kind: 'OWNER_ALERT', alert: 'cardDrained', refId: card.id });

    // Idempotent: the next run changes nothing, writes no audit and adds no second alert.
    await drain.run(new Date());
    expect((await cardOf(card.id)).retiredAt).toEqual(now);
    expect(await audits(card.id)).toHaveLength(1);
    expect((await drainedAlert(card.id))?.timestamp).toBe(job?.timestamp);
  });

  it.each(['PENDING', 'EXPIRED', 'CANCELLED', 'PAID'] as const)(
    'a %s request still reserved keeps the card DRAINING',
    async (status) => {
      const card = await createCard(t.db, { status: 'DRAINING' });
      // PENDING: issued 5 min ago (reserved until expiresAt + grace). The others: their
      // expiresAt + grace is over, the reservation (paidAt + grace for PAID) ends in an hour.
      if (status === 'PENDING') {
        const user = await createUser(t.db);
        await createIntent(t.db, user.id, card.id, { amountTiyin: uniqueAmount() });
      } else {
        await intentEndingAt(t.db, card.id, status, new Date(Date.now() + HOUR));
      }
      await drain.run(new Date());
      const after = await cardOf(card.id);
      expect(after.status).toBe('DRAINING');
      expect(after.retiredAt).toBeNull();
      expect(await audits(card.id)).toHaveLength(0);
      expect(await drainedAlert(card.id)).toBeUndefined();
    },
  );

  it('the boundary is reservedUntil + LATE_STORED_AFTER_MS: at it the card stays, 1 ms after it the card retires', async () => {
    const card = await createCard(t.db, { status: 'DRAINING' });
    const intent = await intentEndingAt(t.db, card.id, 'EXPIRED', endedForDrain());
    const until = intent.reservedUntil;
    if (until === null) throw new Error('a P2P request always has reservedUntil');
    // Already past reservedUntil itself (the allocator's "ended"), still inside the margin.
    await drain.run(new Date(until.getTime() + 1));
    await drain.run(new Date(until.getTime() + LATE - 1));
    // Exactly LATE after: a message dated `until` and stored now is not "late" yet (strict).
    await drain.run(new Date(until.getTime() + LATE));
    expect((await cardOf(card.id)).status).toBe('DRAINING');
    const at = new Date(until.getTime() + LATE + 1);
    await drain.run(at);
    const after = await cardOf(card.id);
    expect(after.status).toBe('RETIRED');
    expect(after.retiredAt).toEqual(at);
  });

  it('L1: a payment made in time but stored 6 min late is CREDITED; the card stays DRAINING', async () => {
    const card = await createCard(t.db, { status: 'DRAINING' });
    // The reservation ended 5 min ago: inside the 10 min margin.
    const until = new Date(Date.now() - 5 * MINUTE);
    const intent = await intentEndingAt(t.db, card.id, 'EXPIRED', until);
    await drain.run(new Date());
    expect((await cardOf(card.id)).status).toBe('DRAINING');

    // Paid 1 min before reservedUntil, stored now (6 min after its Telegram date: not D-47 late).
    const message = await insertMessage(t.db, {
      card,
      amountTiyin: intent.amountTiyin,
      balanceAfterTiyin: 6_000_000n,
      tgDate: new Date(until.getTime() - MINUTE),
    });
    await t.a.matcher.process(message.id, false);
    const outcome = await t.outcome(message.id);
    expect(outcome?.outcome).toBe('CREDITED');
    expect(outcome?.payment?.status).toBe('CONFIRMED');
    const paid = await t.db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(paid.status).toBe('PAID');
    // PAID holds the amount for paidAt + grace: the card is still in use.
    expect(paid.reservedUntil?.getTime()).toBeGreaterThan(Date.now() + GRACE_MS - HOUR);
    await drain.run(new Date());
    expect((await cardOf(card.id)).status).toBe('DRAINING');
  });

  it('never touches ACTIVE, FULL or VERIFYING cards, even with no reservation at all', async () => {
    const cards = await Promise.all(
      (['ACTIVE', 'FULL', 'VERIFYING'] as const).map((status) => createCard(t.db, { status })),
    );
    await drain.run(new Date());
    for (const card of cards) {
      const after = await cardOf(card.id);
      expect(after.status).toBe(card.status);
      expect(after.retiredAt).toBeNull();
      expect(await audits(card.id)).toHaveLength(0);
    }
  });

  it('two sweeps at once: one transition, one audit row, one alert job', async () => {
    const card = await createCard(t.db, { status: 'DRAINING' });
    await intentEndingAt(t.db, card.id, 'CANCELLED', endedForDrain());
    const now = new Date();
    // Separate transactions on separate pool connections, as two worker processes would run.
    const runs = await Promise.all([drain.run(now), drain.run(now), drain.run(now)]);
    expect(runs.every((run) => run.alertsFailed === 0)).toBe(true);
    expect((await cardOf(card.id)).status).toBe('RETIRED');
    expect(await audits(card.id)).toHaveLength(1);
    const jobs = await notify.getJobs(['waiting', 'delayed', 'completed', 'failed']);
    const mine = jobs.filter((j) => {
      const data: unknown = j.data;
      return (
        typeof data === 'object' &&
        data !== null &&
        'alert' in data &&
        data.alert === 'cardDrained' &&
        'refId' in data &&
        data.refId === card.id
      );
    });
    expect(mine).toHaveLength(1);
    expect(await drainedAlert(card.id)).toBeDefined();
  });

  it('a message on the card still awaiting its decision keeps it DRAINING (counted) until decided', async () => {
    const card = await createCard(t.db, { status: 'DRAINING' });
    await intentEndingAt(t.db, card.id, 'EXPIRED', endedForDrain());
    const message = await insertMessage(t.db, {
      card,
      amountTiyin: uniqueAmount(),
      balanceAfterTiyin: 6_000_000n,
    });
    const held = await drain.run(new Date());
    expect(held.heldByMessage).toBeGreaterThanOrEqual(1);
    expect((await cardOf(card.id)).status).toBe('DRAINING');

    // Decided (no request matches: a review), the card retires on the next run.
    await t.a.matcher.process(message.id, false);
    expect((await t.outcome(message.id))?.outcome).toBe('REVIEW');
    await drain.run(new Date());
    expect((await cardOf(card.id)).status).toBe('RETIRED');
  });

  it('runs as a step of the topup-expire sweep; money after the retirement is a CARD_RETIRED review', async () => {
    const card = await createCard(t.db, { status: 'DRAINING' });
    await intentEndingAt(t.db, card.id, 'PAID', endedForDrain());
    const result = await w.expire.run(new Date());
    expect(result.retiredCards).toBeGreaterThanOrEqual(1);
    expect(result.drainAlertsFailed).toBe(0);
    expect((await cardOf(card.id)).status).toBe('RETIRED');

    const message = await insertMessage(t.db, {
      card,
      amountTiyin: uniqueAmount(),
      balanceAfterTiyin: 7_000_000n,
    });
    await t.a.matcher.process(message.id, false);
    const outcome = await t.outcome(message.id);
    expect(outcome?.outcome).toBe('REVIEW');
    expect(outcome?.review?.kind).toBe('CARD_RETIRED');
    expect(await t.db.payment.count({ where: { bankMessageId: message.id } })).toBe(0);
  });
});
