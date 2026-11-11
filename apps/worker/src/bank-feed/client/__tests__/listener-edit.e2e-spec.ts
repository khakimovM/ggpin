import {
  SECURITY_PAUSE_AUDIT,
  alertRef,
  notifyJobId,
  type BankFeedAlertKind,
  type BankFeedSource,
} from '@repo/shared';
import { useMatcherE2e } from '../../__tests__/matcher-e2e.harness';
import {
  MINUTE,
  SENDER_ID,
  SUITE_HOLDER,
  createCard,
  uniqueAmount,
} from '../../__tests__/matcher-e2e.fixtures';
import { uzcardText } from '../../__tests__/synthetic-message';
import { PARSER_VERSION } from '../../parsers/parser-version';
import {
  bootReconcileWorker,
  type ReconcileWorker,
} from '../../../reconcile/__tests__/reconcile-e2e.harness';
import { BankChatAnomalyGuard } from '../bank-chat-anomaly';
import { BankFeedListener } from '../bank-feed-listener';
import { FakeBankFeedClient } from '../fake-bank-feed.client';
import { LeaderLock } from '../leader-lock';
import { ListenerRepository } from '../listener.repository';
import { pause } from './listener-e2e.helpers';
import { MemoryLockStore } from './memory-lock-store';

// Review M1 on the real ggpin_test Postgres + Redis DB 15: an edit nudge finds the stored row
// through the REAL ListenerRepository, by (source, tgMessageId). The account's own (OUTGOING) row
// carries the account's id as senderId, so a lookup by the pinned bot as sender missed it and the
// edit went by silently. The listener is real; only the client (in memory), the poll (recorded),
// the lock store (in memory), the heartbeat, the authorization check and the account check are
// stand-ins. The anomaly guard, its all-cards pause and the notifier are the real ones.
const t = useMatcherE2e();
let w: ReconcileWorker;
/** The working account's own Telegram id (synthetic): the senderId of an OUTGOING row. */
const ACCOUNT_ID = 7_000_000_901n;
const SOURCE: BankFeedSource = 'UZCARD_BOT';
const AT = new Date();
const alerts: [BankFeedAlertKind, string][] = [];
/** Anomaly calls, and the ones the real guard finished (alert queued, every card paused). */
const raises: bigint[] = [];
const raised: bigint[] = [];
const polls: BankFeedSource[] = [];
let listener: BankFeedListener;
let client: FakeBankFeedClient;

beforeAll(async () => {
  w = await bootReconcileWorker(t.env);
  const guard = w.moduleRef.get(BankChatAnomalyGuard);
  client = new FakeBankFeedClient();
  listener = new BankFeedListener({
    client,
    poller: {
      poll: (source, mayRead) => {
        if (mayRead !== undefined && !mayRead()) return Promise.resolve('NOT_LEADER');
        polls.push(source);
        return Promise.resolve('END');
      },
    },
    lock: new LeaderLock(new MemoryLockStore(), 'lock:bank-feed:e2e', 30_000),
    beat: { beat: () => Promise.resolve(), clear: () => Promise.resolve() },
    authorizations: { check: () => Promise.resolve('UNCHANGED' as const) },
    account: { check: () => Promise.resolve('MATCH' as const) },
    messages: w.moduleRef.get(ListenerRepository),
    anomaly: {
      raise: async (source, reason, id, now) => {
        raises.push(id); // the call itself, before the real guard alerts and pauses
        await guard.raise(source, reason, id, now);
        raised.push(id);
      },
    },
    pinnedBot: (source) => w.ingest.pinnedBot(source),
    notifier: {
      alert: async (alert, refId) => {
        await w.notifier.alert(alert, refId);
        alerts.push([alert, refId]);
      },
    },
    timing: { pollMs: 20_000, lockMs: 10_000, watchdogMs: null },
    now: () => AT,
  });
  await listener.tick();
  await listener.settled();
});

afterAll(async () => {
  await listener.onModuleDestroy();
  await w.close();
});

/** A Telegram id of the source with no stored row (the shared DB keeps older runs). */
async function freeId(): Promise<bigint> {
  let id = BigInt(Date.now() + 40_000_000) * 1_000n;
  while ((await t.db.bankMessage.count({ where: { source: SOURCE, tgMessageId: id } })) > 0) {
    id += 1n;
  }
  return id;
}

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await pause(20);
  }
}

/** The owner alert job (read through notifyJob, so the harness removes it at the end). */
const alertJob = (alert: BankFeedAlertKind, refId: string) =>
  t.notifyJob(notifyJobId({ kind: 'OWNER_ALERT', alert, refId }));

/** Decides the row like any other, so nothing is left without an outcome in the shared DB. */
async function decide(rowId: string): Promise<void> {
  await t.a.matcher.process(rowId, false);
  const review = await t.db.paymentReview.findFirst({ where: { bankMessageId: rowId } });
  if (review !== null) await alertJob('rejected', review.id); // marked for cleanup
}

describe('an edit of a stored message, real ListenerRepository (review M1)', () => {
  it('leads: the edit path needs the lead', () => {
    expect(listener.isLeading()).toBe(true);
  });

  it('(b) an edited bank-bot message: `edited` alert, no anomaly and no pause', async () => {
    const card = await createCard(t.db);
    const id = await freeId();
    const date = new Date(Date.now() - MINUTE);
    const text = uzcardText({
      direction: 'CREDIT',
      amountTiyin: uniqueAmount(),
      balanceAfterTiyin: 30_000_000n,
      last4: card.last4,
      bankTxnAt: date,
    });
    // Stored the ordinary way: the pinned bot's own notification.
    const result = await w.ingest.ingest(SOURCE, {
      id,
      date,
      chatId: SENDER_ID,
      senderId: SENDER_ID,
      senderIsBot: true,
      text,
      outgoing: false,
      forwarded: false,
      editDate: null,
      viaBotId: null,
    });
    if (!result.stored) throw new Error(`not stored: ${result.reason}`);
    await w.removeBankMessageJobs([result.bankMessageId]);
    await decide(result.bankMessageId);
    await (await alertJob('edited', result.bankMessageId))?.remove();

    client.emitEdit({ source: SOURCE, messageId: id });
    await until(() => alerts.some(([, ref]) => ref === result.bankMessageId), 'the edited alert');
    await pause(50); // the OUTGOING check runs right after the alert: give it its turn
    expect(await alertJob('edited', result.bankMessageId)).toBeDefined();
    expect(raises).toEqual([]);
    const after = await t.db.topupCard.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.autoCreditPaused).toBe(false);
  });

  it('(a) an edited OUTGOING row (senderId = the account): `edited` + bankChatAnomaly + every card paused', async () => {
    const card = await createCard(t.db);
    const id = await freeId();
    // As ingest stores the account's own message: its own id as sender, REJECTED OUTGOING.
    const row = await t.db.bankMessage.create({
      data: {
        source: SOURCE,
        senderId: ACCOUNT_ID,
        tgMessageId: id,
        tgDate: new Date(Date.now() - MINUTE),
        textSha256: '0'.repeat(64),
        parseStatus: 'REJECTED',
        rejectReason: 'OUTGOING',
        parserVersion: PARSER_VERSION,
      },
    });
    await decide(row.id);
    const ref = alertRef.bankChatAnomaly(SOURCE, 'OUTGOING', AT);
    for (const [alert, refId] of [
      ['edited', row.id],
      ['bankChatAnomaly', ref],
    ] as const) {
      await (await alertJob(alert, refId))?.remove(); // so the jobs below are this test's
    }

    client.emitEdit({ source: SOURCE, messageId: id });
    // The real guard returns once the alert is queued and every live card is paused.
    await until(() => raised.length > 0, 'the anomaly');
    expect(raises).toEqual([id]);
    expect(raised).toEqual([id]);
    expect(alerts).toContainEqual(['edited', row.id]);
    // The guard queues `bankChatAnomaly` through the notifier itself (not the listener's alerts).
    expect(await alertJob('edited', row.id)).toBeDefined();
    expect(await alertJob('bankChatAnomaly', ref)).toBeDefined();
    // ALL cards: this test's and every other live card of this run ((b)'s too).
    const live = await t.db.topupCard.findMany({
      where: { holderName: SUITE_HOLDER, status: { not: 'RETIRED' } },
      select: { id: true, autoCreditPaused: true },
    });
    expect(live.map((c) => c.id)).toEqual(expect.arrayContaining([card.id]));
    expect(live.length).toBeGreaterThan(1);
    for (const c of live) expect(c.autoCreditPaused).toBe(true);
    const audit = await t.db.auditLog.findFirstOrThrow({
      where: { ...SECURITY_PAUSE_AUDIT, targetId: card.id },
    });
    expect(audit).toMatchObject({ reason: 'BANK_CHAT_ANOMALY', actorId: null });
    expect(audit.after).toMatchObject({ autoCreditPaused: true, ref });
  });

  it('(c) an edit of an id not stored yet nudges the poll (the poll stores it as it is now)', async () => {
    const id = await freeId();
    const before = alerts.length;
    polls.length = 0;
    client.emitEdit({ source: SOURCE, messageId: id });
    await until(() => polls.length > 0, 'the poll');
    expect(polls).toEqual([SOURCE]);
    expect(alerts).toHaveLength(before);
  });
});
