import { randomBytes } from 'node:crypto';
import { BANK_FEED_HEARTBEAT_KEY } from '@repo/shared';
import { useMatcherE2e } from '../../__tests__/matcher-e2e.harness';
import { MINUTE, SENDER_ID, createCard, uniqueAmount } from '../../__tests__/matcher-e2e.fixtures';
import { uzcardText } from '../../__tests__/synthetic-message';
import {
  bootReconcileWorker,
  type ReconcileWorker,
} from '../../../reconcile/__tests__/reconcile-e2e.harness';
import { hasOpenSecurityPause, lockBankFeedPause, lockTopupCard, type TopupCard } from '@repo/db';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { AutoCreditPauser } from '../auto-credit-pauser';
import { BankFeedAccountRepository } from '../bank-feed-account.repository';
import type { BankFeedAuthorization, BankFeedMessage } from '../bank-feed-client';
import { BankFeedPoller } from '../bank-feed-poller';
import { RedisBankFeedBeat } from '../heartbeat';
import { LeaderLock, RedisLockStore } from '../leader-lock';
import { ListenerRepository } from '../listener.repository';
import { SecurityPauseRepository, type SecurityPauseEvent } from '../security-pause.repository';
import { FreshDeployment, pause, waitUntilBlockedOnMe } from './listener-e2e.helpers';

// S7 listener parts on the real ggpin_test Postgres + Redis DB 15 with the in-memory client (no
// Telegram). Cards this file pauses are RETIRED in `finally`: an open security pause on a live card
// would make every later card:add on this DB create its card paused (D-52 D2, r2).
const t = useMatcherE2e();
let w: ReconcileWorker;
const stored: string[] = [];

beforeAll(async () => {
  w = await bootReconcileWorker(t.env);
});

afterAll(async () => {
  await w.removeBankMessageJobs(stored);
  await w.close();
});

const auth = (hash: string): BankFeedAuthorization => ({
  hash,
  current: false,
  createdAt: new Date('2030-01-01T00:00:00.000Z'),
  appName: 'Test Desktop',
  deviceModel: 'Test PC',
});

function message(id: bigint, last4: string): BankFeedMessage {
  const date = new Date(Date.now() - MINUTE);
  return {
    id,
    date,
    chatId: SENDER_ID,
    senderId: SENDER_ID,
    senderIsBot: true,
    text: uzcardText({
      direction: 'CREDIT',
      amountTiyin: uniqueAmount(),
      balanceAfterTiyin: 70_000_000n,
      last4,
      bankTxnAt: date,
    }),
    outgoing: false,
    forwarded: false,
    editDate: null,
    viaBotId: null,
  };
}

describe('bank-feed listener parts (real Postgres + Redis)', () => {
  it('Redis leader lock: one holder; after a missed renewal the TTL frees it for the standby', async () => {
    const key = `lock:bank-feed:e2e:${randomBytes(4).toString('hex')}`;
    const store = new RedisLockStore(t.redis.client);
    // Timing comes from PTTL and a forced expiry, not from sleep margins (no flake under load).
    const a = new LeaderLock(store, key, 30_000);
    const b = new LeaderLock(store, key, 30_000);
    expect(await a.hold()).toBe(true);
    expect(await b.hold()).toBe(false);
    await t.redis.client.pexpire(key, 5_000); // as if the TTL had almost run out
    expect(await a.hold()).toBe(true); // renewed: the TTL is full again
    expect(await t.redis.client.pttl(key)).toBeGreaterThan(20_000);
    expect(await b.hold()).toBe(false); // still a's
    await t.redis.client.pexpire(key, 1); // a is "dead": it stopped renewing and the TTL ran out
    await pause(50);
    expect(await b.hold()).toBe(true);
    expect(await a.hold()).toBe(false);
    await a.release(); // not a's any more: b keeps it
    expect(await t.redis.client.get(key)).toBe(b.token);
    await b.release();
    expect(await t.redis.client.get(key)).toBeNull();
  });

  it('heartbeat is epoch ms (what the API reads) and is cleared on stop', async () => {
    const beat = new RedisBankFeedBeat(t.redis.client);
    const at = new Date();
    await beat.beat(at);
    expect(await t.redis.client.get(BANK_FEED_HEARTBEAT_KEY)).toBe(String(at.getTime()));
    await beat.clear();
    expect(await t.redis.client.get(BANK_FEED_HEARTBEAT_KEY)).toBeNull();
  });

  it('D-52 D1/D4: the first account is bound in Postgres, another is MISMATCH; hashes persist', async () => {
    // Only this file touches these two tables on the test DB (no listener runs on it).
    await t.db.bankFeedAccount.deleteMany({});
    await t.db.bankFeedAuthorization.deleteMany({});
    try {
      // The shared test DB has bank messages of other suites: a fresh deployment has none.
      const repo = new FreshDeployment(w.moduleRef.get(PrismaService));
      const both = await Promise.all([repo.check(7_000_000_101n), repo.check(7_000_000_101n)]);
      expect(both.sort()).toEqual(['BOUND', 'MATCH']); // two workers at once: one row
      expect(await repo.check(7_000_000_101n)).toBe('MATCH');
      expect(await repo.check(7_000_000_202n)).toBe('MISMATCH');
      expect(await t.db.bankFeedAccount.count()).toBe(1);
      expect(await repo.knownHashes()).toEqual(new Set());
      await repo.remember([auth('0'), auth('18446744073709551000')]);
      await repo.remember([auth('0')]); // already known: skipped, no error
      expect([...(await repo.knownHashes())].sort()).toEqual(['0', '18446744073709551000']);
      const row = await t.db.bankFeedAuthorization.findUniqueOrThrow({ where: { hash: '0' } });
      expect(row).toMatchObject({ appName: 'Test Desktop', deviceModel: 'Test PC' });
      // The DB itself refuses a hash that is not an unsigned 64-bit decimal (CHECK).
      await expect(t.db.bankFeedAuthorization.create({ data: { hash: '-1' } })).rejects.toThrow();
    } finally {
      await t.db.bankFeedAccount.deleteMany({});
      await t.db.bankFeedAuthorization.deleteMany({});
    }
  });

  it('poll: one row per message (update + poll + restart), in id order, from the stored cursor', async () => {
    const card = await createCard(t.db);
    const repo = w.moduleRef.get(ListenerRepository);
    const base = ((await repo.cursor('UZCARD_BOT')) ?? 0n) + 1_000n;
    const ids = [base + 3n, base + 1n, base + 2n];
    w.client.clear();
    for (const id of ids) w.client.put('UZCARD_BOT', message(id, card.last4));
    const poller = new BankFeedPoller(w.client, w.ingest, repo);
    // A nudge from the live update and the timer poll at the same moment.
    await Promise.all([poller.poll('UZCARD_BOT'), poller.poll('UZCARD_BOT')]);
    // A restarted worker reads again from the stored cursor: nothing new.
    await new BankFeedPoller(w.client, w.ingest, repo).poll('UZCARD_BOT');
    expect(w.client.calls.at(-1)?.minId).toBe(base + 3n);
    const rows = await t.db.bankMessage.findMany({
      where: { senderId: SENDER_ID, tgMessageId: { in: ids } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, tgMessageId: true, createdAt: true },
    });
    expect(rows.map((r) => r.tgMessageId)).toEqual([base + 1n, base + 2n, base + 3n]);
    for (const row of rows) {
      stored.push(row.id);
      await t.a.matcher.process(row.id, false); // decided, so no row is left open
    }
    expect(await repo.cursor('UZCARD_BOT')).toBe(base + 3n);
    w.client.clear();
  });

  it('D-52 r2 L-B: no bound account but stored history (cursor or messages) is UNBOUND_HISTORY, never a new binding', async () => {
    await t.db.bankFeedAccount.deleteMany({});
    try {
      // The poll above stored messages: a lost BankFeedAccount row must not bind a new account.
      const repo = w.moduleRef.get(BankFeedAccountRepository);
      expect(await repo.check(7_000_000_303n)).toBe('UNBOUND_HISTORY');
      expect(await t.db.bankFeedAccount.count()).toBe(0);
      expect(await repo.boundAt()).toBeNull();
    } finally {
      await t.db.bankFeedAccount.deleteMany({});
    }
  });

  it('M-A: the security pause covers every non-retired card (VERIFYING too), each under its card lock, with one SYSTEM CARD_PAUSE row per card', async () => {
    const active = await createCard(t.db);
    const verifying = await createCard(t.db, { status: 'VERIFYING' });
    const chainPaused = await createCard(t.db, { paused: true }); // a chain-break pause, no row
    const ids = [active.id, verifying.id, chainPaused.id];
    const pauses = w.moduleRef.get(SecurityPauseRepository);
    // The locked list holds all three; the pause below takes only these, so no other card of the
    // shared test DB is touched.
    expect(await pauses.cardsToPause()).toEqual(expect.arrayContaining(ids));
    const pauser = w.moduleRef.get(AutoCreditPauser);
    const event: SecurityPauseEvent = { reason: 'NEW_AUTHORIZATION', ref: 'e2e-ref' };
    let pauseDone = false;
    let doneWhileHeld = true;
    let pausing: Promise<number> = Promise.resolve(0);
    try {
      // Another worker holds the lock of the active card: the pause has to wait for it.
      await t.db.$transaction(
        async (tx) => {
          await lockTopupCard(tx, active.id);
          pausing = pauser
            .pauseCards([verifying.id, chainPaused.id, active.id], event)
            .then((n) => {
              pauseDone = true;
              return n;
            });
          await waitUntilBlockedOnMe(tx); // the pause now waits on this lock (pg_locks)
          doneWhileHeld = pauseDone;
        },
        { timeout: 20_000 },
      );
      expect(await pausing).toBe(3); // finishes only after the holder committed
      expect(doneWhileHeld).toBe(false);
      const cards = await t.db.topupCard.findMany({
        where: { id: { in: ids } },
        select: { autoCreditPaused: true },
      });
      expect(cards).toEqual(ids.map(() => ({ autoCreditPaused: true })));
      const rows = await t.db.auditLog.findMany({
        where: { targetType: 'TopupCard', targetId: { in: ids }, action: 'CARD_PAUSE' },
        select: { targetId: true, actorType: true, actorId: true, reason: true, after: true },
      });
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row).toMatchObject({
          actorType: 'SYSTEM',
          actorId: null,
          reason: 'NEW_AUTHORIZATION',
        });
        expect(row.after).toMatchObject({ autoCreditPaused: true, ref: 'e2e-ref' });
      }
      const chainRow = rows.find((r) => r.targetId === chainPaused.id);
      expect(chainRow?.after).toMatchObject({ alreadyPaused: true });
      for (const id of ids) expect(await hasOpenSecurityPause(t.db, id)).toBe(true);
      // A second event while the pause is open writes nothing (M-B: a flood stays bounded).
      const again = pauser.pauseCards(ids, { reason: 'BANK_CHAT_ANOMALY', ref: 'x' });
      await expect(again).resolves.toBe(0);
      const count = await t.db.auditLog.count({
        where: { targetId: { in: ids }, action: 'CARD_PAUSE' },
      });
      expect(count).toBe(3);
      const left = await pauses.cardsToPause();
      for (const id of ids) expect(left).not.toContain(id);
    } finally {
      await pausing.catch(() => undefined);
      await retire(ids);
    }
  });

  it('I-A: the list to pause is read under the pause lock card:add takes, so a card committed meanwhile is in it', async () => {
    const pauses = w.moduleRef.get(SecurityPauseRepository);
    const late: TopupCard[] = [];
    let readDone = false;
    let doneWhileHeld = true;
    let reading: Promise<string[]> = Promise.resolve([]);
    try {
      // As card:add does: the pause lock first, then the new (unpaused) card, then commit.
      await t.db.$transaction(
        async (tx) => {
          await lockBankFeedPause(tx);
          reading = pauses.cardsToPause().then((ids) => {
            readDone = true;
            return ids;
          });
          await waitUntilBlockedOnMe(tx); // the locked read waits on the pause lock
          late.push(await createCard(tx));
          doneWhileHeld = readDone;
        },
        { timeout: 20_000 },
      );
      const ids = await reading;
      expect(doneWhileHeld).toBe(false);
      expect(late).toHaveLength(1);
      expect(ids).toContain(late[0]?.id);
    } finally {
      await reading.catch(() => undefined);
      await retire(late.map((c) => c.id));
    }
  });
});

/** RETIRED is final and ends the security pause of the card for card:add (openSecurityPause). */
async function retire(ids: readonly string[]): Promise<void> {
  await t.db.topupCard.updateMany({
    where: { id: { in: [...ids] } },
    data: { status: 'RETIRED', retiredAt: new Date() },
  });
}
