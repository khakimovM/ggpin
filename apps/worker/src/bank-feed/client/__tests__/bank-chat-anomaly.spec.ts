import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { WorkerConfig } from '../../../config/config.module';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { BankFeedNotifier } from '../../bank-feed-notifier';
import type { TopupCardsRepository } from '../../topup-cards.repository';
import { AutoCreditPauser, type SecurityPauseEvent } from '../auto-credit-pauser';
import { BankChatAnomalyGuard, bankChatAnomalyOf } from '../bank-chat-anomaly';
import type { BankFeedAccountRepository } from '../bank-feed-account.repository';
import type { BankFeedMessage } from '../bank-feed-client';
import { IngestService } from '../ingest.service';
import type { SecurityPauseRepository } from '../security-pause.repository';

// D-52 (review L-1, r2 M-B/I-C): the working account only reads the bank bots. OUTGOING (also an
// edit of an own message), FOREIGN_SENDER and NOT_BOT are security events: alert first (one an
// hour per source and reason), then the all-cards security pause, and only then is the message
// stored. An own message written before the account was bound is a setup message, not an event.
const BOT = 900_000_002n;
const T0 = new Date('2030-05-01T10:00:00.000Z');
const BOUND_AT = new Date('2030-05-01T09:00:00.000Z');
const HOUR_MS = 3_600_000;

function message(over: Partial<BankFeedMessage> = {}): BankFeedMessage {
  return {
    id: 77n,
    date: T0,
    chatId: BOT,
    senderId: BOT,
    senderIsBot: true,
    text: 'synthetic',
    outgoing: false,
    forwarded: false,
    editDate: null,
    viaBotId: null,
    ...over,
  };
}

/** A pauser over a fake pause repository: `rounds` are the successive locked reads. */
function pauserWith(rounds: string[][]) {
  const locked: string[] = [];
  const events: SecurityPauseEvent[] = [];
  const pauses = {
    cardsToPause: jest.fn(() => Promise.resolve(rounds.shift() ?? [])),
    pauseCard: jest.fn((_tx: unknown, _id: string, event: SecurityPauseEvent) => {
      events.push(event);
      return Promise.resolve(true);
    }),
    client: { $transaction: (fn: (tx: unknown) => Promise<boolean>) => fn({}) },
  };
  const cards = {
    setLockTimeout: () => Promise.resolve(),
    lockCard: (_tx: unknown, id: string) => Promise.resolve(void locked.push(id)),
    cardLockTxOptions: () => ({}),
  };
  const pauser = new AutoCreditPauser(
    pauses as unknown as SecurityPauseRepository,
    cards as unknown as TopupCardsRepository,
  );
  return { pauser, pauses, locked, events };
}

function guardWith(pauser: Pick<AutoCreditPauser, 'pauseAll'>, boundAt: Date | null = BOUND_AT) {
  const alerts: string[] = [];
  const notifier = {
    alert: (kind: string, ref: string) => Promise.resolve(void alerts.push(`${kind}:${ref}`)),
  };
  const accounts = { boundAt: () => Promise.resolve(boundAt) };
  const guard = new BankChatAnomalyGuard(
    pauser as AutoCreditPauser,
    notifier as unknown as BankFeedNotifier,
    accounts as unknown as BankFeedAccountRepository,
  );
  return { guard, alerts };
}

describe('bank chat anomalies (D-52, review L-1, r2 M-B and I-C)', () => {
  beforeEach(() => {
    for (const level of ['error', 'warn'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });
  afterEach(() => jest.restoreAllMocks());

  it('maps only OUTGOING, FOREIGN_SENDER and NOT_BOT to an anomaly', () => {
    for (const r of ['OUTGOING', 'FOREIGN_SENDER', 'NOT_BOT']) expect(bankChatAnomalyOf(r)).toBe(r);
    for (const r of [null, 'FORWARDED', 'EDITED', 'VIA_BOT', 'FOREIGN_CHAT']) {
      expect(bankChatAnomalyOf(r)).toBeNull();
    }
  });

  it('alerts FIRST (refId source_reason_hour), then pauses with the security event; a failed pause still has its alert out', async () => {
    const order: string[] = [];
    const pauser = {
      pauseAll: jest.fn((event: SecurityPauseEvent) => {
        order.push(`pause:${event.reason}:${event.ref}`);
        return Promise.resolve(2);
      }),
    };
    const { guard, alerts } = guardWith(pauser);
    await guard.raise('UZCARD_BOT', 'OUTGOING', 77n, T0);
    const hour = String(Math.floor(T0.getTime() / HOUR_MS));
    expect(alerts).toEqual([`bankChatAnomaly:UZCARD_BOT_OUTGOING_${hour}`]);
    expect(order).toEqual([`pause:BANK_CHAT_ANOMALY:UZCARD_BOT_OUTGOING_${hour}`]);
    pauser.pauseAll.mockRejectedValueOnce(new Error('card busy'));
    await expect(guard.raise('HUMO_BOT', 'NOT_BOT', 5n, T0)).rejects.toThrow('card busy');
    expect(alerts.at(-1)).toBe(`bankChatAnomaly:HUMO_BOT_NOT_BOT_${hour}`);
  });

  it('M-B: 500 OUTGOING messages in one hour send ONE alert and pause each card once; the next hour alerts again', async () => {
    // The first locked read finds the two live cards; afterwards they are under the pause.
    const fake = pauserWith([['c1', 'c2']]);
    const { guard, alerts } = guardWith(fake.pauser);
    for (let i = 0; i < 500; i += 1) {
      await guard.raise('UZCARD_BOT', 'OUTGOING', BigInt(1000 + i), new Date(T0.getTime() + i));
    }
    expect(alerts).toHaveLength(1);
    expect(fake.locked).toEqual(['c1', 'c2']);
    expect(fake.pauses.pauseCard).toHaveBeenCalledTimes(2);
    // Bounded: one locked read per raise once nothing is left (plus the re-read after pausing).
    expect(fake.pauses.cardsToPause).toHaveBeenCalledTimes(501);
    await guard.raise('UZCARD_BOT', 'OUTGOING', 2000n, new Date(T0.getTime() + HOUR_MS));
    expect(alerts).toHaveLength(2);
  });

  it('D2 / I-A: pauseAll re-reads under the pause lock (a card added meanwhile is paused too); endless arrivals throw', async () => {
    const event: SecurityPauseEvent = { reason: 'NEW_AUTHORIZATION', ref: 'h1' };
    const calm = pauserWith([['c1', 'c2'], ['c3'], []]);
    await expect(calm.pauser.pauseAll(event)).resolves.toBe(3);
    expect(calm.locked).toEqual(['c1', 'c2', 'c3']);
    expect(calm.events.every((e) => e === event)).toBe(true);
    const idle = pauserWith([]);
    await expect(idle.pauser.pauseAll(event)).resolves.toBe(0);
    expect(idle.locked).toEqual([]);
    const busy = pauserWith([['c1'], ['c3'], ['c4'], ['c5'], ['c6']]);
    await expect(busy.pauser.pauseAll(event)).rejects.toThrow('keep appearing unpaused');
  });

  it('I-C: only an OUTGOING message last touched before the binding is a setup message; unbound fails closed', async () => {
    const { guard } = guardWith(pauserWith([]).pauser);
    const before = new Date(BOUND_AT.getTime() - 60_000);
    const after = new Date(BOUND_AT.getTime() + 60_000);
    const setup = (reason: 'OUTGOING' | 'NOT_BOT', date: Date, editDate: Date | null, g = guard) =>
      g.isSetupMessage(reason, { date, editDate });
    await expect(setup('OUTGOING', before, null)).resolves.toBe(true);
    await expect(setup('OUTGOING', after, null)).resolves.toBe(false);
    // An old own message edited after the binding is someone using the account now.
    await expect(setup('OUTGOING', before, after)).resolves.toBe(false);
    await expect(setup('NOT_BOT', before, null)).resolves.toBe(false);
    const unbound = guardWith(pauserWith([]).pauser, null).guard;
    await expect(setup('OUTGOING', before, null, unbound)).resolves.toBe(false);
  });

  it('ingest: an OUTGOING message (an edited one too) raises the anomaly BEFORE storing; a failed raise stores nothing; a setup message is stored without one', async () => {
    const transaction = jest.fn(() => Promise.reject(new Error('stop here')));
    const raise = jest.fn((): Promise<void> => Promise.resolve());
    const isSetupMessage = jest.fn(() => Promise.resolve(false));
    const ingest = new IngestService(
      { client: { $transaction: transaction } } as unknown as PrismaService,
      {} as Queue,
      { BANK_FEED_UZCARD_BOT_ID: BOT } as unknown as WorkerConfig,
      { alert: () => Promise.resolve() } as unknown as BankFeedNotifier,
      { raise, isSetupMessage } as unknown as BankChatAnomalyGuard,
    );
    const own = message({ outgoing: true, editDate: new Date('2030-05-01T10:05:00.000Z') });
    await expect(ingest.ingest('UZCARD_BOT', own, T0)).rejects.toThrow('stop here');
    expect(raise).toHaveBeenCalledWith('UZCARD_BOT', 'OUTGOING', 77n, T0);
    expect(raise.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.mock.invocationCallOrder[0] ?? 0,
    );
    raise.mockRejectedValueOnce(new Error('redis away'));
    transaction.mockClear();
    await expect(ingest.ingest('UZCARD_BOT', message({ senderIsBot: false }))).rejects.toThrow(
      'redis away',
    );
    expect(transaction).not.toHaveBeenCalled(); // nothing stored: the next poll raises again
    raise.mockClear();
    await expect(ingest.ingest('UZCARD_BOT', message())).rejects.toThrow('stop here');
    expect(raise).not.toHaveBeenCalled(); // an ordinary bot message is no anomaly
    isSetupMessage.mockResolvedValueOnce(true);
    transaction.mockClear();
    await expect(ingest.ingest('UZCARD_BOT', message({ outgoing: true }), T0)).rejects.toThrow(
      'stop here',
    );
    expect(raise).not.toHaveBeenCalled(); // setup message: stored REJECTED, no alert, no pause
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
