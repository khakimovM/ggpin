import type { BankFeedSource } from '@repo/shared';
import type { BankFeedMessage } from '../bank-feed-client';
import { BankFeedPoller } from '../bank-feed-poller';
import { FakeBankFeedClient } from '../fake-bank-feed.client';
import type { IngestResult } from '../ingest.service';

const BOT = 900_000_001n;
const AFTER = new Date('2030-05-01T10:01:00.000Z');

function message(id: number, date = AFTER, chatId = BOT): BankFeedMessage {
  return {
    id: BigInt(id),
    date,
    chatId,
    senderId: BOT,
    senderIsBot: true,
    text: 'synthetic',
    outgoing: false,
    forwarded: false,
    editDate: null,
    viaBotId: null,
  };
}

/** An ingest double with the real one's essentials: one row per id, cursor = highest stored id. */
function setup(opts: { cursor?: bigint | null; maxPages?: number; now?: () => Date } = {}) {
  const client = new FakeBankFeedClient();
  const stored: bigint[] = [];
  let cursor = opts.cursor ?? null;
  let failAt: bigint | null = null;
  const ingest = {
    pinnedBot: (source: BankFeedSource) => (source === 'HUMO_BOT' ? BOT : null),
    ingest: async (_source: BankFeedSource, m: BankFeedMessage): Promise<IngestResult> => {
      await Promise.resolve();
      if (failAt === m.id) throw new Error('db down');
      if (m.chatId !== BOT) return { stored: false, reason: 'FOREIGN_CHAT' };
      if (stored.includes(m.id)) return { stored: false, reason: 'DUPLICATE' };
      stored.push(m.id);
      cursor = cursor === null || m.id > cursor ? m.id : cursor;
      return { stored: true, bankMessageId: `cm3${String(m.id)}` };
    },
  };
  const inits: bigint[] = [];
  const cursors = {
    cursor: () => Promise.resolve(cursor),
    initCursor: (_source: BankFeedSource, id: bigint) => {
      inits.push(id);
      cursor = cursor === null || id > cursor ? id : cursor;
      return Promise.resolve();
    },
  };
  const make = () => new BankFeedPoller(client, ingest, cursors, opts.maxPages, opts.now);
  return {
    client,
    stored,
    inits,
    make,
    failOn: (id: bigint | null) => {
      failAt = id;
    },
  };
}

describe('BankFeedPoller', () => {
  it('S6 I3: ingests in ascending id order, across pages, to the empty page', async () => {
    const t = setup({ cursor: 0n });
    for (const id of [250, 7, 120, 3, 101]) t.client.put('HUMO_BOT', message(id));
    expect(await t.make().poll('HUMO_BOT')).toBe('END');
    expect(t.stored).toEqual([3n, 7n, 101n, 120n, 250n]);
  });

  it('an update that was lost is found by the next poll; a restart continues from the cursor', async () => {
    const t = setup({ cursor: 0n });
    t.client.put('HUMO_BOT', message(1));
    const poller = t.make();
    await poller.poll('HUMO_BOT');
    t.client.put('HUMO_BOT', message(2)); // its live update never came
    await poller.poll('HUMO_BOT');
    expect(t.stored).toEqual([1n, 2n]);
    t.client.put('HUMO_BOT', message(3));
    const restarted = t.make();
    await restarted.poll('HUMO_BOT');
    expect(t.stored).toEqual([1n, 2n, 3n]);
    expect(t.client.calls.at(-2)?.minId).toBe(2n); // read from the stored cursor
  });

  it('a nudge and a timer poll at once: one ingest per message (serialised per source)', async () => {
    const t = setup({ cursor: 0n });
    for (let id = 1; id <= 5; id += 1) t.client.put('HUMO_BOT', message(id));
    const poller = t.make();
    await Promise.all([poller.poll('HUMO_BOT'), poller.poll('HUMO_BOT'), poller.poll('HUMO_BOT')]);
    expect(t.stored).toEqual([1n, 2n, 3n, 4n, 5n]);
  });

  it('D-52 M3: at most one poll waits behind the running one; later nudges join it', async () => {
    const t = setup({ cursor: 0n });
    t.client.put('HUMO_BOT', message(1));
    const poller = t.make();
    const running = poller.poll('HUMO_BOT');
    const waiting = [poller.poll('HUMO_BOT'), poller.poll('HUMO_BOT'), poller.poll('HUMO_BOT')];
    expect(waiting[1]).toBe(waiting[0]);
    expect(waiting[2]).toBe(waiting[0]);
    await Promise.all([running, ...waiting]);
    // The running poll read page 1 and the empty page; the one waiting poll read the empty page.
    expect(t.client.calls).toHaveLength(3);
    expect(t.stored).toEqual([1n]);
  });

  it('D-52 M2: first start (no cursor at all) begins at the newest message with one call, no history walk', async () => {
    const t = setup({ cursor: null });
    for (let id = 1; id <= 450; id += 1) t.client.put('HUMO_BOT', message(id));
    const poller = t.make();
    expect(await poller.poll('HUMO_BOT')).toBe('END');
    expect(t.inits).toEqual([450n]);
    expect(t.stored).toEqual([]);
    expect(t.client.calls).toEqual([{ source: 'HUMO_BOT', minId: 450n, limit: 100 }]);
    t.client.put('HUMO_BOT', message(451));
    await poller.poll('HUMO_BOT');
    expect(t.stored).toEqual([451n]);
    const empty = setup({ cursor: null });
    await empty.make().poll('HUMO_BOT');
    expect(empty.inits).toEqual([0n]);
  });

  it('D-52 I2: the guard is checked before every page; false stops the poll (NOT_LEADER)', async () => {
    const t = setup({ cursor: 0n });
    for (let id = 1; id <= 250; id += 1) t.client.put('HUMO_BOT', message(id));
    let pages = 0;
    const guard = () => {
      pages += 1;
      return pages <= 2; // the run's own check + page 1; page 2 is refused
    };
    expect(await t.make().poll('HUMO_BOT', guard)).toBe('NOT_LEADER');
    expect(t.stored).toHaveLength(100);
    expect(await t.make().poll('HUMO_BOT', () => false)).toBe('NOT_LEADER');
    expect(t.client.calls).toHaveLength(1);
  });

  it('a database error stops at that message; the next poll retries it, nothing skipped', async () => {
    const t = setup({ cursor: 0n });
    for (const id of [1, 2, 3]) t.client.put('HUMO_BOT', message(id));
    const poller = t.make();
    t.failOn(2n);
    await expect(poller.poll('HUMO_BOT')).rejects.toThrow('db down');
    expect(t.stored).toEqual([1n]);
    t.failOn(null);
    expect(await poller.poll('HUMO_BOT')).toBe('END');
    expect(t.stored).toEqual([1n, 2n, 3n]);
  });

  it('another chat in a page: stops there, not healthy, the cursor never passes it', async () => {
    const t = setup({ cursor: 0n });
    t.client.put('HUMO_BOT', message(1));
    t.client.put('HUMO_BOT', message(2, AFTER, 555n));
    t.client.put('HUMO_BOT', message(3));
    const poller = t.make();
    expect(await poller.poll('HUMO_BOT')).toBe('FOREIGN_CHAT');
    expect(await poller.poll('HUMO_BOT')).toBe('FOREIGN_CHAT');
    expect(t.stored).toEqual([1n]);
  });

  it('a source without a pinned bot is never read; a long backlog is PAGE_CAP, not an error', async () => {
    const t = setup({ cursor: 0n, maxPages: 2 });
    for (let id = 1; id <= 250; id += 1) t.client.put('HUMO_BOT', message(id));
    const poller = t.make();
    expect(await poller.poll('UZCARD_BOT')).toBe('NOT_PINNED');
    expect(await poller.poll('HUMO_BOT')).toBe('PAGE_CAP');
    expect(t.stored).toHaveLength(200);
    expect(await poller.poll('HUMO_BOT')).toBe('END');
    expect(t.stored).toHaveLength(250);
  });

  it('D-52 r2 M-C: an empty read while newer messages exist is BLIND (unhealthy) until a read gets them', async () => {
    let ms = AFTER.getTime();
    const t = setup({ cursor: 10n, now: () => new Date(ms) });
    t.client.put('HUMO_BOT', message(11));
    const fetchSince = t.client.fetchSince.bind(t.client);
    t.client.fetchSince = () => Promise.resolve([]); // a paging bug: every read says "nothing new"
    const latest = jest.spyOn(t.client, 'latestMessageId');
    const poller = t.make();
    expect(await poller.poll('HUMO_BOT')).toBe('BLIND');
    expect(await poller.poll('HUMO_BOT')).toBe('BLIND'); // checked on every poll while blind
    expect(latest).toHaveBeenCalledTimes(2);
    t.client.fetchSince = fetchSince;
    expect(await poller.poll('HUMO_BOT')).toBe('END');
    expect(t.stored).toEqual([11n]);
    // Healthy again: the newest id is checked at most every 5 minutes per source.
    expect(await poller.poll('HUMO_BOT')).toBe('END');
    expect(latest).toHaveBeenCalledTimes(3);
    ms += 5 * 60_000;
    expect(await poller.poll('HUMO_BOT')).toBe('END');
    expect(latest).toHaveBeenCalledTimes(4);
  });
});
