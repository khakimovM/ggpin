import { QUEUES, RECONCILE_AUDIT, notifyJobId, tashkentDayKey } from '@repo/shared';
import { Queue } from 'bullmq';
import { useMatcherE2e } from '../../bank-feed/__tests__/matcher-e2e.harness';
import {
  HOUR,
  MINUTE,
  SENDER_ID,
  createCard,
  createIntent,
  createUser,
  insertMessage,
  uniqueAmount,
} from '../../bank-feed/__tests__/matcher-e2e.fixtures';
import { uzcardText } from '../../bank-feed/__tests__/synthetic-message';
import type { BankFeedMessage } from '../../bank-feed/client/bank-feed-client';
import { HistoryRescanService } from '../history-rescan.service';
import { OUTCOME_SETTLE_MS } from '../../bank-feed/orphan-requeue.service';
import {
  PaymentReconcileService,
  RECONCILE_WINDOW_MS,
  type ReconcileReport,
} from '../payment-reconcile.service';
import { PAYMENT_RECONCILE_SCHEDULE } from '../payment-reconcile.scheduler';
import { chainBreaks, creditUnaccounted } from '../reconcile-checks';
import { bootReconcileWorker, type ReconcileWorker } from './reconcile-e2e.harness';

// The daily reconciliation on the real ggpin_test DB (docs/05 §10). Its checks are global and
// the DB is shared, so the mismatch test compares two runs at the SAME instant, before and
// after this file's fixtures: the difference is exactly what the fixtures caused. Every run
// uses NOW (20 min ahead, so the fixtures are past the 15 min settle time) and so one day key.
const t = useMatcherE2e();
const NOW = new Date(Date.now() + 20 * MINUTE);
const DAY = tashkentDayKey(NOW);
// Telegram ids of the fake chat: above every id `insertMessage` gives in this run.
let chatId = BigInt(Date.now() + 10_000_000) * 1_000n;
let w: ReconcileWorker;
const ingested: string[] = [];
// A history message was sent 15 min ago: older than the re-scan's 10 min "the listener still
// has it" bound (S9-M1), so the re-scan takes it and it is "stored late" by construction.
const SENT_AGO_MS = 15 * MINUTE;

beforeAll(async () => {
  w = await bootReconcileWorker(t.env);
  await removeReconcileAlerts();
});

// useMatcherE2e's afterAll runs first (jest-circus: declaration order) and closes its notify
// queue; it also removes every notify job read through t.notifyJob, the reconcile alerts too.
afterAll(async () => {
  await w.removeBankMessageJobs(ingested);
  await w.close();
});

/** Clears the day's reconcile alerts left by an earlier run (and marks them for cleanup). */
async function removeReconcileAlerts() {
  for (const alert of ['reconcileOk', 'reconcileMismatch'] as const) {
    await (await t.notifyJob(notifyJobId({ kind: 'OWNER_ALERT', alert, refId: DAY })))?.remove();
  }
}

function chatMessage(text: string, over: Partial<BankFeedMessage> = {}): BankFeedMessage {
  chatId += 1n;
  return {
    id: chatId,
    date: new Date(Date.now() - SENT_AGO_MS),
    chatId: SENDER_ID,
    senderId: SENDER_ID,
    senderIsBot: true,
    text,
    outgoing: false,
    forwarded: false,
    editDate: null,
    viaBotId: null,
    ...over,
  };
}

function creditText(amountTiyin: bigint, last4: string, balanceAfterTiyin: bigint): string {
  return uzcardText({
    direction: 'CREDIT',
    amountTiyin,
    balanceAfterTiyin,
    last4,
    bankTxnAt: new Date(Date.now() - SENT_AGO_MS),
  });
}

async function run(): Promise<ReconcileReport> {
  const report = await w.reconcile.run(NOW);
  ingested.push(...report.history.sources.UZCARD_BOT.recovered);
  return report;
}

const counts = (r: ReconcileReport): Record<string, number> =>
  Object.fromEntries(Object.entries(r.mismatches).map(([code, f]) => [code, f.count]));

describe('payment-reconcile (real Postgres + Redis, fake bank-feed client)', () => {
  afterEach(() => {
    w.client.clear();
  });

  it('a message the listener missed is found in the history and credited by the normal flow', async () => {
    const user = await createUser(t.db);
    const card = await createCard(t.db);
    const amountTiyin = uniqueAmount();
    // Opened before the money was sent and still PENDING: a late PENDING message is credited.
    const intent = await createIntent(t.db, user.id, card.id, {
      amountTiyin,
      createdAt: new Date(Date.now() - SENT_AGO_MS - 5 * MINUTE),
    });
    const missed = chatMessage(creditText(amountTiyin, card.last4, 80_000_000n));
    w.client.put('UZCARD_BOT', missed);

    const report = await run();
    expect(report.history.sources.UZCARD_BOT.recovered).toHaveLength(1);
    const [recoveredId] = report.history.sources.UZCARD_BOT.recovered;
    expect(report.ok).toBe(false); // a recovered message is itself a finding
    expect(report.mismatches.recovered.count).toBe(1);
    const row = await t.db.bankMessage.findUniqueOrThrow({ where: { id: recoveredId ?? '' } });
    expect(row).toMatchObject({ parseStatus: 'PARSED', cardId: card.id, tgMessageId: missed.id });

    // Ingest queued the ordinary job; the matcher decides it as it would have live.
    const job = await w.bankMessages.getJob(`bm-${row.id}`);
    expect(job?.data).toEqual({ bankMessageId: row.id });
    await expect(t.a.matcher.process(row.id, false)).resolves.toBe('PROCESSED');
    expect(await t.outcome(row.id)).toMatchObject({ outcome: 'CREDITED' });
    const paid = await t.db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(paid.status).toBe('PAID');

    // The next run knows the id: nothing is stored or queued twice.
    const again = await run();
    expect(again.history.sources.UZCARD_BOT).toMatchObject({ state: 'ok', recovered: [] });
    const stored = await t.db.bankMessage.count({
      where: { senderId: SENDER_ID, tgMessageId: missed.id },
    });
    expect(stored).toBe(1);
  });

  it('a forwarded message from the history is stored REJECTED and goes to review, never money', async () => {
    const card = await createCard(t.db);
    const text = creditText(uniqueAmount(), card.last4, 70_000_000n);
    w.client.put('UZCARD_BOT', chatMessage(text, { forwarded: true }));
    const [id] = (await run()).history.sources.UZCARD_BOT.recovered;
    const row = await t.db.bankMessage.findUniqueOrThrow({ where: { id: id ?? '' } });
    expect(row).toMatchObject({ parseStatus: 'REJECTED', rejectReason: 'FORWARDED', cardId: null });
    await t.a.matcher.process(row.id, false);
    expect(await t.outcome(row.id)).toMatchObject({ outcome: 'REVIEW', payment: null });
  });

  it('counts each mismatch its fixture causes, exactly', async () => {
    const before = await run();
    // missingOutcome + creditUnaccounted: a CREDIT nobody decided.
    const silentCard = await createCard(t.db);
    const silent = await insertMessage(t.db, {
      card: silentCard,
      amountTiyin: uniqueAmount(),
      balanceAfterTiyin: 60_000_000n,
    });
    // missingOutcome only: stuck since a Telegram date three days back, outside the 48 h
    // window. The all-time count still names it (S9 M1: no silent drop after 48 h).
    const oldStuck = await insertMessage(t.db, {
      card: null,
      amountTiyin: uniqueAmount(),
      balanceAfterTiyin: 61_000_000n,
      tgDate: new Date(Date.now() - 72 * HOUR),
    });
    // chainBreak: the second message does not follow from the first (both reviewed: accounted).
    const chainCard = await createCard(t.db);
    const link = await insertMessage(t.db, {
      card: chainCard,
      amountTiyin: 10_000n,
      balanceAfterTiyin: 1_000_000n,
    });
    const gap = await insertMessage(t.db, {
      card: chainCard,
      amountTiyin: 10_000n,
      balanceAfterTiyin: 5_000_000n,
    });
    await t.a.matcher.process(link.id, false);
    await t.a.matcher.process(gap.id, false);
    // pendingPastGrace: a PENDING request whose reservation ended days ago (no sweep ran).
    const staleUser = await createUser(t.db);
    const stale = await createIntent(t.db, staleUser.id, (await createCard(t.db)).id, {
      amountTiyin: uniqueAmount(),
      createdAt: new Date(Date.now() - 72 * HOUR),
    });
    expect(stale.reservedUntil?.getTime() ?? Infinity).toBeLessThan(NOW.getTime());
    // lateOverLimit: paid 1.5 h after expiry (past the 1 h hold) on a card now over its limit.
    const smallCard = await createCard(t.db, { limitTiyin: 1_000_000n });
    const lateUser = await createUser(t.db);
    const lateAmount = uniqueAmount();
    await createIntent(t.db, lateUser.id, smallCard.id, {
      amountTiyin: lateAmount,
      status: 'EXPIRED',
      createdAt: new Date(Date.now() - 2 * HOUR),
    });
    const late = await insertMessage(t.db, {
      card: smallCard,
      amountTiyin: lateAmount,
      balanceAfterTiyin: 40_000_000n,
    });
    await t.a.matcher.process(late.id, false);
    expect((await t.outcome(late.id))?.payment?.status).toBe('CONFIRMED');

    const after = await run();
    const was = counts(before);
    const delta = Object.fromEntries(
      Object.entries(counts(after)).map(([code, n]) => [code, n - (was[code] ?? 0)]),
    );
    expect(delta).toEqual({
      recovered: 0,
      missingOutcome: 2,
      creditUnaccounted: 1,
      paymentWithoutMessage: 0, // refused by the DB (CHECK): the check is a guard
      chainBreak: 1,
      pendingPastGrace: 1,
      lateOverLimit: 1,
      reviewOpenOver24h: 0, // every review this file opens is younger than 24 h
      purgeOverdue: 0, // every text this file stores is still within its retention
    });
    expect(after.ok).toBe(false);

    // The same rules over this file's cards name exactly the fixtures.
    const cards = [silentCard.id, chainCard.id, smallCard.id];
    const window = await w.repo.messagesSince(new Date(NOW.getTime() - RECONCILE_WINDOW_MS));
    const mine = window.filter((m) => cards.includes(m.cardId ?? ''));
    const settled = new Date(NOW.getTime() - OUTCOME_SETTLE_MS);
    expect(window.some((m) => m.id === oldStuck.id)).toBe(false); // outside the window
    expect(mine.find((m) => m.id === silent.id)?.outcome).toBeNull();
    expect(creditUnaccounted(mine, settled).ids).toEqual([silentCard.id]);
    expect(chainBreaks(mine, new Map(cards.map((id) => [id, null]))).breaks.ids).toEqual([gap.id]);

    const audit = await t.db.auditLog.findUniqueOrThrow({ where: { id: after.auditId } });
    expect(audit).toMatchObject({ ...RECONCILE_AUDIT, targetId: DAY, actorId: null });
    expect(audit.after).toMatchObject({ mismatches: counts(after), historyScan: 'ok' });
    // Ids, counts and DEBIT sums only: no card number, no balance, no bank text.
    const json = JSON.stringify(audit.after);
    for (const leak of [silentCard.pan, `***${silentCard.last4}`, 'UZS', 'balance', 'text']) {
      expect(json).not.toContain(leak);
    }
  });

  it('two runs on one day with the same verdict queue ONE alert; each run keeps its audit row', async () => {
    const first = await run();
    const second = await run();
    expect(second.ok).toBe(first.ok);
    expect(second.auditId).not.toBe(first.auditId);
    const alert = first.ok ? 'reconcileOk' : 'reconcileMismatch';
    const jobId = notifyJobId({ kind: 'OWNER_ALERT', alert, refId: DAY });
    const job = await t.notifyJob(jobId);
    expect(job?.data).toEqual({ kind: 'OWNER_ALERT', alert, refId: DAY });
    const queuedAt = job?.timestamp;
    await run();
    expect((await t.notifyJob(jobId))?.timestamp).toBe(queuedAt);
  });

  it('without a client the history is "unavailable" and the verdict is a mismatch, never ok', async () => {
    const service = new PaymentReconcileService(
      w.repo,
      new HistoryRescanService(null, w.ingest, w.repo, w.notifier),
      w.notifier,
      w.config,
    );
    const report = await service.run(NOW);
    expect(report.history.state).toBe('unavailable');
    expect(report.ok).toBe(false);
    const audit = await t.db.auditLog.findUniqueOrThrow({ where: { id: report.auditId } });
    expect(audit.after).toMatchObject({ historyScan: 'unavailable' });
    const jobId = notifyJobId({ kind: 'OWNER_ALERT', alert: 'reconcileMismatch', refId: DAY });
    expect(await t.notifyJob(jobId)).toBeDefined();
  });

  it('a client error makes the history "failed" (a mismatch)', async () => {
    w.client.failWith = new Error('synthetic telegram outage');
    const report = await run();
    expect(report.history.state).toBe('failed');
    expect(report.ok).toBe(false);
  });

  it('the cron fires at 03:00 Asia/Tashkent (22:00 UTC)', async () => {
    const queue = new Queue(QUEUES.PAYMENT_RECONCILE, { connection: { url: t.env.REDIS_URL } });
    const id = `${PAYMENT_RECONCILE_SCHEDULE.id}-e2e-${String(Date.now())}`;
    try {
      await queue.upsertJobScheduler(id, PAYMENT_RECONCILE_SCHEDULE.rule, {
        name: PAYMENT_RECONCILE_SCHEDULE.jobName,
        data: {},
      });
      const scheduler = await queue.getJobScheduler(id);
      const next = new Date(scheduler?.next ?? 0);
      expect(next.getUTCHours()).toBe(22);
      expect(next.getUTCMinutes()).toBe(0);
      expect(next.getTime()).toBeGreaterThan(Date.now());
      expect(next.getTime() - Date.now()).toBeLessThanOrEqual(24 * HOUR);
    } finally {
      await queue.removeJobScheduler(id);
      const left = (await queue.getDelayed()).filter((j) => j.repeatJobKey === id);
      for (const job of left) await job.remove();
      await queue.close();
    }
  });
});
