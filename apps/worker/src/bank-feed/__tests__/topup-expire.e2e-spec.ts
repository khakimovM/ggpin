import { bankMessageJobId, cardLimitAlertRef, notifyJobId } from '@repo/shared';
import {
  bootReconcileWorker,
  type ReconcileWorker,
} from '../../reconcile/__tests__/reconcile-e2e.harness';
import { useMatcherE2e } from './matcher-e2e.harness';
import { OUTCOME_SETTLE_MS } from '../orphan-requeue.service';
import {
  MINUTE,
  createCard,
  createIntent,
  createUser,
  insertMessage,
  uniqueAmount,
} from './matcher-e2e.fixtures';

// The every-minute `topup-expire` sweep on the real ggpin_test DB (docs/05 §10). The sweep is
// global by design (every overdue PENDING, every ACTIVE card), so the assertions name this
// file's rows only.
const t = useMatcherE2e();
let w: ReconcileWorker;
// The sweep re-queues every undecided message of the shared DB (S9 m1) and nothing consumes the
// `bank-message` queue here: the jobs it made live are removed again after the file.
const LIVE = ['waiting', 'delayed', 'prioritized', 'paused'] as const;
let liveBefore = new Set<string>();

beforeAll(async () => {
  w = await bootReconcileWorker(t.env);
  const jobs = await w.bankMessages.getJobs([...LIVE]);
  liveBefore = new Set(jobs.map((j) => j.id ?? ''));
});

afterAll(async () => {
  for (const job of await w.bankMessages.getJobs([...LIVE])) {
    if (!liveBefore.has(job.id ?? '')) await job.remove();
  }
  await w.close();
});

async function intentFor(opts: { createdAt: Date; status?: 'PENDING' | 'PAID' }) {
  const user = await createUser(t.db);
  const card = await createCard(t.db);
  return createIntent(t.db, user.id, card.id, { amountTiyin: uniqueAmount(), ...opts });
}

function statusOf(id: string) {
  return t.db.paymentIntent.findUniqueOrThrow({ where: { id }, select: { status: true } });
}

function alertJob(alert: 'cardFull' | 'cardNearLimit', refId: string) {
  return t.notifyJob(notifyJobId({ kind: 'OWNER_ALERT', alert, refId }));
}

describe('topup-expire sweep (real Postgres + Redis)', () => {
  it('expires an overdue PENDING request and touches neither a due one nor a PAID one', async () => {
    const overdue = await intentFor({ createdAt: new Date(Date.now() - 40 * MINUTE) });
    const due = await intentFor({ createdAt: new Date(Date.now() - 5 * MINUTE) });
    const paid = await intentFor({ createdAt: new Date(Date.now() - 40 * MINUTE), status: 'PAID' });
    const paidBefore = await t.db.paymentIntent.findUniqueOrThrow({ where: { id: paid.id } });

    const result = await w.expire.run(new Date());
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(await statusOf(overdue.id)).toEqual({ status: 'EXPIRED' });
    expect(await statusOf(due.id)).toEqual({ status: 'PENDING' });
    // PAID is untouched, every column (the reservation and paidAt included).
    expect(await t.db.paymentIntent.findUniqueOrThrow({ where: { id: paid.id } })).toEqual(
      paidBefore,
    );
    // The amount stays reserved through its grace window: reservedUntil did not move.
    const expired = await t.db.paymentIntent.findUniqueOrThrow({ where: { id: overdue.id } });
    expect(expired.reservedUntil).toEqual(overdue.reservedUntil);
  });

  it('uses the API predicate: due exactly at expiresAt is expired; a second sweep changes nothing', async () => {
    const intent = await intentFor({ createdAt: new Date(Date.now() - 10 * MINUTE) });
    await w.expire.run(new Date(intent.expiresAt.getTime() - 1));
    expect(await statusOf(intent.id)).toEqual({ status: 'PENDING' });
    await w.expire.run(intent.expiresAt);
    expect(await statusOf(intent.id)).toEqual({ status: 'EXPIRED' });
    await w.expire.run(new Date(intent.expiresAt.getTime() + MINUTE));
    expect(await statusOf(intent.id)).toEqual({ status: 'EXPIRED' });
  });

  it('a card at 100 % of its received limit becomes FULL and the owner gets cardFull once', async () => {
    const card = await createCard(t.db, { limitTiyin: 1_000_000n });
    await insertMessage(t.db, { card, amountTiyin: 1_000_000n, balanceAfterTiyin: 7_000_000n });
    const first = await w.expire.run(new Date());
    expect(first.madeFull).toBeGreaterThanOrEqual(1);
    const after = await t.db.topupCard.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.status).toBe('FULL');

    const ref = cardLimitAlertRef('cardFull', {
      cardId: card.id,
      receiveLimitTiyin: card.receiveLimitTiyin,
      monthlyLimitTiyin: card.monthlyLimitTiyin,
    });
    const job = await alertJob('cardFull', ref);
    expect(job?.data).toEqual({ kind: 'OWNER_ALERT', alert: 'cardFull', refId: ref });
    const queuedAt = job?.timestamp;

    // The FULL card is no longer ACTIVE: the next sweep neither moves it nor re-alerts.
    await w.expire.run(new Date());
    expect((await alertJob('cardFull', ref))?.timestamp).toBe(queuedAt);
  });

  it('a card at 80-99 % gets cardNearLimit and stays ACTIVE; a card below 80 % gets nothing', async () => {
    const near = await createCard(t.db, { limitTiyin: 1_000_000n });
    const below = await createCard(t.db, { limitTiyin: 1_000_000n });
    await insertMessage(t.db, { card: near, amountTiyin: 850_000n, balanceAfterTiyin: 9_000_000n });
    await insertMessage(t.db, {
      card: below,
      amountTiyin: 790_000n,
      balanceAfterTiyin: 9_000_000n,
    });
    await w.expire.run(new Date());

    const limits = (c: typeof near) => ({
      cardId: c.id,
      receiveLimitTiyin: c.receiveLimitTiyin,
      monthlyLimitTiyin: c.monthlyLimitTiyin,
    });
    const nearRef = cardLimitAlertRef('cardNearLimit', limits(near));
    expect((await alertJob('cardNearLimit', nearRef))?.data).toMatchObject({ refId: nearRef });
    expect((await t.db.topupCard.findUniqueOrThrow({ where: { id: near.id } })).status).toBe(
      'ACTIVE',
    );
    const belowRef = cardLimitAlertRef('cardNearLimit', limits(below));
    expect(await alertJob('cardNearLimit', belowRef)).toBeUndefined();
  });

  it('an undecided message past the settle time gets its bm-<id> job back; a decided one does not', async () => {
    const lost = await insertMessage(t.db, {
      card: await createCard(t.db),
      amountTiyin: uniqueAmount(),
      balanceAfterTiyin: 8_000_000n,
    });
    const decided = await insertMessage(t.db, {
      card: await createCard(t.db),
      amountTiyin: uniqueAmount(),
      balanceAfterTiyin: 8_000_000n,
    });
    await t.a.matcher.process(decided.id, false);

    // Still settling (stored 0 min ago): left alone.
    await w.expire.run(new Date());
    expect(await w.bankMessages.getJob(bankMessageJobId(lost.id))).toBeUndefined();

    const later = new Date(Date.now() + OUTCOME_SETTLE_MS + MINUTE);
    const result = await w.expire.run(later);
    expect(result.requeuedMessages).toBeGreaterThanOrEqual(1);
    const job = await w.bankMessages.getJob(bankMessageJobId(lost.id));
    expect(job?.data).toEqual({ bankMessageId: lost.id });
    expect(await w.bankMessages.getJob(bankMessageJobId(decided.id))).toBeUndefined();

    // The job is waiting: the next sweep leaves it as it is (same job, same timestamp).
    await w.expire.run(later);
    expect((await w.bankMessages.getJob(bankMessageJobId(lost.id)))?.timestamp).toBe(
      job?.timestamp,
    );
  });
});
