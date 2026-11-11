import { Logger } from '@nestjs/common';
import type { BankFeedSource } from '@repo/shared';
import { AuthorizationsWatch } from '../authorizations-watch';
import type { BankFeedAccountRepository } from '../bank-feed-account.repository';
import type { BankFeedAuthorization } from '../bank-feed-client';
import { BankFeedListener } from '../bank-feed-listener';
import { BankFeedPoller } from '../bank-feed-poller';
import type { IngestResult } from '../ingest.service';
import { LeaderLock } from '../leader-lock';
import { MtcuteBankFeedClient } from '../mtcute-bank-feed.client';
import { FakeRpcError, FakeTelegram, authorization, mtMessage } from './fake-mtcute';
import { MemoryLockStore } from './memory-lock-store';

// docs/05 §11: the session, the phone, the message text, a balance, a card number and the
// authorizations' IP/country never reach a log. One run through the whole listener path with
// every one of them present (all synthetic), capturing every Nest log call.
const HUMO = 900_000_001;
const UZCARD = 900_000_002;
const SESSION = 'TESTSESSIONsecretXYZ';
const TEXT = [
  '\u{1F7E2} Perevod na kartu',
  '➕ 50 017.00 UZS',
  '\u{1F4B3} ***4321',
  '\u{1F4CD} TEST BANK P2P, UZ',
  '\u{1F550} 01.05.30 15:00',
  '\u{1F4B5} 987 654.32 UZS',
].join('\n');
const FORBIDDEN = [
  SESSION,
  'Perevod',
  '4321',
  '987 654',
  '50 017',
  '+998000000000',
  '203.0.113.77',
  'Testland',
  'Test Region',
];

class MemoryKnown implements Pick<BankFeedAccountRepository, 'knownHashes' | 'remember'> {
  hashes = new Set<string>();
  knownHashes(): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set(this.hashes));
  }
  remember(list: readonly BankFeedAuthorization[]): Promise<void> {
    for (const a of list) this.hashes.add(a.hash);
    return Promise.resolve();
  }
}

describe('bank-feed logs (log capture)', () => {
  const lines: string[] = [];
  beforeEach(() => {
    lines.length = 0;
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });
    }
  });
  afterEach(() => jest.restoreAllMocks());

  it('no session, text, balance, card number, phone or IP in any log line; a heartbeat still beats', async () => {
    const tg = new FakeTelegram();
    tg.users = [
      { id: HUMO, isBot: true, username: 'HUMOcardbot' },
      { id: UZCARD, isBot: true, username: 'CardXabarBot' },
    ];
    tg.put(UZCARD, mtMessage(1, UZCARD, { message: TEXT }));
    tg.put(UZCARD, mtMessage(2, UZCARD, { message: TEXT, editDate: 1_900_000_999 }));
    tg.authorizations = [authorization(0n, { current: true })];
    const client = new MtcuteBankFeedClient(tg, {
      bots: { HUMO_BOT: BigInt(HUMO), UZCARD_BOT: BigInt(UZCARD) },
      openSession: () => SESSION,
    });
    const ingested: string[] = [];
    const ingest = {
      pinnedBot: (source: BankFeedSource) => BigInt(source === 'HUMO_BOT' ? HUMO : UZCARD),
      ingest: (_s: BankFeedSource, m: { text: string; id: bigint }): Promise<IngestResult> => {
        ingested.push(m.text);
        return Promise.resolve({ stored: true, bankMessageId: `cm3${String(m.id)}` });
      },
    };
    const known = new MemoryKnown();
    const beats: Date[] = [];
    const listener = new BankFeedListener({
      client,
      poller: new BankFeedPoller(
        client,
        ingest,
        { cursor: () => Promise.resolve(0n), initCursor: () => Promise.resolve() },
        5,
      ),
      lock: new LeaderLock(new MemoryLockStore(), 'lock:bank-feed', 30_000),
      beat: { beat: (at) => Promise.resolve(void beats.push(at)), clear: () => Promise.resolve() },
      authorizations: new AuthorizationsWatch(
        known,
        { pauseAll: () => Promise.resolve(2) },
        {
          alert: () => Promise.resolve(),
        },
      ),
      account: { check: () => Promise.resolve('BOUND' as const) },
      messages: {
        storedMessage: () => Promise.resolve({ id: 'cm3stored', rejectReason: null }),
      },
      anomaly: { raise: () => Promise.resolve() },
      pinnedBot: ingest.pinnedBot,
      notifier: { alert: () => Promise.resolve() },
      timing: { pollMs: 20_000, lockMs: 10_000, watchdogMs: 5 * 60_000 },
    });
    known.hashes.add('0'); // the bound account's own session is already known (D-52 D1)
    await listener.tick(); // takes the lock; the start runs beside it
    await listener.settled(); // leads, checks authorizations, polls, heartbeat
    tg.authorizations = [authorization(0n, { current: true }), authorization(99n)];
    tg.onError.emit(new FakeRpcError('FLOOD_WAIT_7', 420));
    await listener.pollRound(); // new authorization: paused + alerted
    tg.failNext = new FakeRpcError('AUTH_KEY_UNREGISTERED');
    await listener.pollRound(); // session revoked: stops

    expect(ingested).toEqual([TEXT, TEXT]); // the text did go to ingest, and only there
    expect(beats.length).toBeGreaterThanOrEqual(1);
    expect(listener.state).toBe('stopped');
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join('\n');
    for (const secret of FORBIDDEN) expect(all).not.toContain(secret);
  });
});
