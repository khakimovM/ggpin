import { alertRef } from '@repo/shared';
import type { BankFeedClient } from '../../bank-feed/client/bank-feed-client';
import { FakeBankFeedClient } from '../../bank-feed/client/fake-bank-feed.client';
import { LATE_STORED_AFTER_MS } from '../../bank-feed/match-rules';
import { RESCAN_CLOCK_MARGIN_MS, RESCAN_MAX_PAGES, RESCAN_PAGE } from '../history-rescan.service';
import { NOW, SINCE, message, setup } from './history-rescan.harness';

// The re-scan's paging and verdicts with in-memory fakes (history-rescan.harness.ts); the database
// path (a recovered message stored, queued and credited) is in payment-reconcile.e2e-spec.ts.

describe('HistoryRescanService', () => {
  it('is unavailable (never ok) without a client, and reads nothing', async () => {
    const { service, ingested } = setup(null);
    const result = await service.rescan(SINCE, NOW);
    expect(result.state).toBe('unavailable');
    expect(result.sources.HUMO_BOT).toMatchObject({ state: 'unavailable', reason: 'NO_CLIENT' });
    expect(result.sources.UZCARD_BOT).toMatchObject({ state: 'unavailable', reason: 'NO_CLIENT' });
    expect(ingested).toEqual([]);
  });

  it('D-52: is unavailable (NOT_LEADER) and reads nothing when the listener may not read (not leading or no fresh authorization check)', async () => {
    const client = new FakeBankFeedClient();
    client.put('HUMO_BOT', message(101));
    const { service, ingested } = setup(client, { leading: false });
    const result = await service.rescan(SINCE, NOW);
    expect(result.state).toBe('unavailable');
    expect(result.sources.HUMO_BOT).toMatchObject({ state: 'unavailable', reason: 'NOT_LEADER' });
    expect(result.sources.UZCARD_BOT).toMatchObject({ state: 'unavailable', reason: 'NOT_LEADER' });
    expect(client.calls).toEqual([]);
    expect(ingested).toEqual([]);
    const leader = setup(client, { leading: true });
    expect((await leader.service.rescan(SINCE, NOW)).sources.HUMO_BOT.state).toBe('ok');
  });

  it('I-B (r3): mayRead is checked before every page; lost before page 2, the read stops there', async () => {
    const client = new FakeBankFeedClient();
    for (let id = 101; id <= 100 + RESCAN_PAGE + 5; id += 1) client.put('HUMO_BOT', message(id));
    let checks = 0;
    // True for the source check and page 1, then the lead (or the fresh check) is gone.
    const { service, ingested } = setup(client, { leading: () => (checks += 1) <= 2 });
    const result = await service.rescan(SINCE, NOW);
    expect(result.state).toBe('unavailable');
    expect(result.sources.HUMO_BOT).toMatchObject({
      state: 'unavailable',
      reason: 'NOT_LEADER',
      fetched: RESCAN_PAGE,
    });
    expect(result.sources.UZCARD_BOT).toMatchObject({ state: 'unavailable', reason: 'NOT_LEADER' });
    // One page read from the stored cursor; the cursor never moved on to a second fetch.
    expect(client.calls).toEqual([{ source: 'HUMO_BOT', minId: 100n, limit: RESCAN_PAGE }]);
    expect(ingested).toHaveLength(RESCAN_PAGE);
  });

  it('is unavailable for a source without a pinned bot id', async () => {
    const client = new FakeBankFeedClient();
    const { service } = setup(client, { pins: { HUMO_BOT: 900_000_001n, UZCARD_BOT: null } });
    const result = await service.rescan(SINCE, NOW);
    expect(result.sources.HUMO_BOT).toMatchObject({ state: 'ok', reason: null });
    expect(result.sources.UZCARD_BOT).toMatchObject({ state: 'unavailable', reason: 'NOT_PINNED' });
    expect(result.state).toBe('unavailable');
    expect(client.calls.every((c) => c.source === 'HUMO_BOT')).toBe(true);
  });

  it('pages from the last id before the window and ingests only unknown ids, in order', async () => {
    const client = new FakeBankFeedClient();
    for (let id = 101; id <= 101 + RESCAN_PAGE + 20; id += 1) client.put('HUMO_BOT', message(id));
    client.put('UZCARD_BOT', message(5, 'UZCARD_BOT'));
    const known = [...Array(RESCAN_PAGE + 21).keys()]
      .map((i) => BigInt(101 + i))
      .filter((id) => id !== 150n && id !== 210n);
    const { service, ingested } = setup(client, { known });
    const result = await service.rescan(SINCE, NOW);

    expect(result.state).toBe('ok');
    expect(result.sources.HUMO_BOT).toEqual({
      state: 'ok',
      reason: null,
      fetched: RESCAN_PAGE + 21,
      recovered: ['cm3rec150', 'cm3rec210'],
    });
    expect(result.sources.UZCARD_BOT).toEqual({
      state: 'ok',
      reason: null,
      fetched: 1,
      recovered: ['cm3rec5'],
    });
    expect(ingested).toEqual([
      { source: 'HUMO_BOT', id: 150n },
      { source: 'HUMO_BOT', id: 210n },
      { source: 'UZCARD_BOT', id: 5n },
    ]);
    // A short page (21) is not the end: only the empty page after it is.
    expect(client.calls.filter((c) => c.source === 'HUMO_BOT').map((c) => c.minId)).toEqual([
      100n,
      BigInt(100 + RESCAN_PAGE),
      BigInt(100 + RESCAN_PAGE + 21),
    ]);
    expect(client.calls.filter((c) => c.source === 'UZCARD_BOT').map((c) => c.minId)).toEqual([
      0n,
      5n,
    ]);
  });

  it('first re-scan of a source (nothing stored before the window): older messages are skipped', async () => {
    const client = new FakeBankFeedClient();
    const old = new Date(SINCE.getTime() - 1);
    client.put('UZCARD_BOT', message(3, 'UZCARD_BOT', old));
    client.put('UZCARD_BOT', message(4, 'UZCARD_BOT', SINCE));
    const { service, ingested } = setup(client);
    const result = await service.rescan(SINCE, NOW);
    expect(result.sources.UZCARD_BOT).toEqual({
      state: 'ok',
      reason: null,
      fetched: 2,
      recovered: ['cm3rec4'],
    });
    expect(ingested).toEqual([{ source: 'UZCARD_BOT', id: 4n }]);
  });

  it('a later re-scan ingests a missed message after the last stored one, whatever its date', async () => {
    const client = new FakeBankFeedClient();
    // HUMO_BOT has a stored message (id 100) before the window: id 101 was missed since then.
    client.put('HUMO_BOT', message(101, 'HUMO_BOT', new Date(SINCE.getTime() - 60_000)));
    const { service, ingested } = setup(client, {
      pins: { HUMO_BOT: 900_000_001n, UZCARD_BOT: null },
    });
    await service.rescan(SINCE, NOW);
    expect(ingested).toEqual([{ source: 'HUMO_BOT', id: 101n }]);
  });

  it('leaves a message no older than LATE_STORED_AFTER_MS + the clock margin to the listener (D-47, S9 security I1)', async () => {
    const client = new FakeBankFeedClient();
    // The margin: a Postgres clock a minute behind must still see every stored row as late.
    expect(RESCAN_CLOCK_MARGIN_MS).toBe(60_000);
    const bound = new Date(NOW.getTime() - LATE_STORED_AFTER_MS - RESCAN_CLOCK_MARGIN_MS);
    client.put('HUMO_BOT', message(101, 'HUMO_BOT', new Date(bound.getTime() - 1)));
    client.put('HUMO_BOT', message(102, 'HUMO_BOT', bound));
    client.put('HUMO_BOT', message(103, 'HUMO_BOT', new Date(NOW.getTime() - 60_000)));
    const { service, ingested } = setup(client, {
      pins: { HUMO_BOT: 900_000_001n, UZCARD_BOT: null },
    });
    const result = await service.rescan(SINCE, NOW);
    // Only 101 is stored: everything this path stores is "stored late" by its own row.
    expect(ingested).toEqual([{ source: 'HUMO_BOT', id: 101n }]);
    expect(result.sources.HUMO_BOT).toEqual({
      state: 'ok',
      reason: null,
      fetched: 3,
      recovered: ['cm3rec101'],
    });
  });

  it('is failed when the client throws, logging the error name only', async () => {
    const client = new FakeBankFeedClient();
    client.failWith = new Error('synthetic network failure');
    const { service, logError } = setup(client);
    const result = await service.rescan(SINCE, NOW);
    expect(result.state).toBe('failed');
    expect(result.sources.HUMO_BOT).toEqual({
      state: 'failed',
      reason: 'CLIENT_ERROR',
      fetched: 0,
      recovered: [],
    });
    // The error NAME only: never its message (it could quote a chat).
    expect(logError).toHaveBeenCalledWith('history re-scan source=HUMO_BOT failed: Error');
  });

  it('is failed for a client that does not move forward', async () => {
    const stuck: BankFeedClient = {
      fetchSince: () => Promise.resolve(Array.from({ length: RESCAN_PAGE }, () => message(50))),
    };
    const { service } = setup(stuck, { known: [50n] });
    expect((await service.rescan(SINCE, NOW)).sources.HUMO_BOT).toMatchObject({
      state: 'failed',
      reason: 'NO_PROGRESS',
    });
  });

  it('is failed when the history is longer than RESCAN_MAX_PAGES pages', async () => {
    let calls = 0;
    const endless: BankFeedClient = {
      fetchSince: (_source, minId) => {
        calls += 1;
        return Promise.resolve(
          Array.from({ length: RESCAN_PAGE }, (_, i) => message(Number(minId) + i + 1)),
        );
      },
    };
    const { service } = setup(endless, { pins: { HUMO_BOT: 900_000_001n, UZCARD_BOT: null } });
    const result = await service.rescan(SINCE, NOW);
    expect(result.sources.HUMO_BOT).toMatchObject({ state: 'failed', reason: 'TOO_LONG' });
    expect(result.sources.HUMO_BOT.fetched).toBe(RESCAN_MAX_PAGES * RESCAN_PAGE);
    expect(calls).toBe(RESCAN_MAX_PAGES);
  });

  it('S9F-I2: a page with a message of another chat fails closed; nothing of it is ingested', async () => {
    // A client that breaks its contract (the fake is fed the foreign row directly).
    const client = new FakeBankFeedClient();
    for (let id = 101; id <= 200; id += 1) client.put('HUMO_BOT', message(id)); // a full page
    client.put('HUMO_BOT', message(201));
    client.put('HUMO_BOT', { ...message(202), chatId: 900_000_777n });
    client.put('HUMO_BOT', message(203));
    const { service, ingested, logError, alert } = setup(client);
    const result = await service.rescan(SINCE, NOW);
    expect(result.state).toBe('failed');
    expect(result.sources.HUMO_BOT).toMatchObject({ state: 'failed', reason: 'FOREIGN_CHAT' });
    // L-1: the owner gets the listener's hourly foreignChat alert (same refId: one an hour).
    expect(alert.mock.calls).toEqual([['foreignChat', alertRef.foreignChat('HUMO_BOT', NOW)]]);
    // The clean first page was ingested; of the second page nothing, and no third read.
    const humo = ingested.filter((i) => i.source === 'HUMO_BOT').map((i) => i.id);
    expect(humo).toHaveLength(100);
    expect(humo).not.toContain(201n);
    expect(humo).not.toContain(203n);
    expect(client.calls.filter((c) => c.source === 'HUMO_BOT').map((c) => c.minId)).toEqual([
      100n,
      200n,
    ]);
    // Codes only: no text, no chat id.
    expect(logError).toHaveBeenCalledWith(
      'history re-scan source=HUMO_BOT page has another chat: FOREIGN_CHAT',
    );
  });

  it('L-1: a failing foreignChat alert is logged; the source is FOREIGN_CHAT failed all the same', async () => {
    const client = new FakeBankFeedClient();
    client.put('HUMO_BOT', { ...message(101), chatId: 900_000_777n });
    const { service, ingested, logError, alert } = setup(client);
    alert.mockRejectedValue(new Error('synthetic redis down'));
    const result = await service.rescan(SINCE, NOW);
    expect(result.sources.HUMO_BOT).toMatchObject({ state: 'failed', reason: 'FOREIGN_CHAT' });
    expect(ingested.filter((i) => i.source === 'HUMO_BOT')).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      'history re-scan source=HUMO_BOT foreignChat alert failed: Error',
    );
  });
});
