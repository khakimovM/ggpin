import { Logger } from '@nestjs/common';
import { AuthorizationsWatch } from '../authorizations-watch';
import type { BankFeedAccountRepository } from '../bank-feed-account.repository';
import type { SecurityPauseEvent } from '../security-pause.repository';
import type { BankFeedAuthorization } from '../bank-feed-client';

/** The Postgres table's behaviour in memory (BankFeedAuthorization, hash unique). */
class MemoryKnown implements Pick<BankFeedAccountRepository, 'knownHashes' | 'remember'> {
  readonly rows: BankFeedAuthorization[] = [];
  knownHashes(): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set(this.rows.map((r) => r.hash)));
  }
  remember(list: readonly BankFeedAuthorization[]): Promise<void> {
    for (const a of list) if (!this.rows.some((r) => r.hash === a.hash)) this.rows.push(a);
    return Promise.resolve();
  }
}

const NOW = new Date('2030-05-01T10:30:00.000Z');
const HOUR = String(Math.floor(NOW.getTime() / 3_600_000));

const auth = (hash: string, current = false): BankFeedAuthorization => ({
  hash,
  current,
  createdAt: new Date('2030-01-01T00:00:00.000Z'),
  appName: 'Test Desktop',
  deviceModel: 'Test PC',
});

function setup() {
  const known = new MemoryKnown();
  const order: string[] = [];
  const pauser = {
    pauseAll: jest.fn((_event: SecurityPauseEvent) => {
      order.push('pause');
      return Promise.resolve(3);
    }),
  };
  const notifier = {
    alert: jest.fn((alert: string, ref: string) => {
      order.push(`${alert}:${ref}`);
      return Promise.resolve();
    }),
  };
  const watch = new AuthorizationsWatch(known, pauser, notifier);
  return { known, order, pauser, notifier, watch };
}

describe('AuthorizationsWatch (D-52 D1: Postgres, alert first, no silent baseline)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('an empty table is never a silent baseline: alert, pause ALL cards, then record', async () => {
    const t = setup();
    await expect(t.watch.check([auth('0', true), auth('11')], NOW)).resolves.toBe(
      'BASELINE_PAUSED',
    );
    expect(t.order).toEqual([`authorizationsBaseline:${HOUR}`, 'pause']);
    expect(t.known.rows.map((r) => r.hash)).toEqual(['0', '11']);
    await expect(t.watch.check([auth('0', true), auth('11')], NOW)).resolves.toBe('UNCHANGED');
    expect(t.pauser.pauseAll).toHaveBeenCalledTimes(1);
    // r2 M-A: the AuditLog rows of the pause carry the reason and the alert refId.
    expect(t.pauser.pauseAll).toHaveBeenCalledWith({ reason: 'AUTH_BASELINE', ref: HOUR });
  });

  it('a new hash: one alert per hash FIRST, then the pause, then it is remembered', async () => {
    const t = setup();
    await t.known.remember([auth('0', true)]);
    await expect(t.watch.check([auth('0', true), auth('44'), auth('45')], NOW)).resolves.toBe(
      'NEW_PAUSED',
    );
    expect(t.order).toEqual(['newAuthorization:44', 'newAuthorization:45', 'pause']);
    expect(t.pauser.pauseAll).toHaveBeenCalledWith({ reason: 'NEW_AUTHORIZATION', ref: '44' });
    expect(t.known.rows.map((r) => r.hash)).toEqual(['0', '44', '45']);
    // Device labels are kept for the owner (never an IP: the client does not read it).
    expect(t.known.rows[1]).toMatchObject({ appName: 'Test Desktop', deviceModel: 'Test PC' });
  });

  it('review I4: a failed pause still has its alert out, and nothing is remembered (next round again)', async () => {
    const t = setup();
    await t.known.remember([auth('0', true)]);
    t.pauser.pauseAll.mockRejectedValueOnce(new Error('card busy'));
    await expect(t.watch.check([auth('0', true), auth('44')], NOW)).rejects.toThrow('card busy');
    expect(t.order).toEqual(['newAuthorization:44']);
    expect(t.known.rows.map((r) => r.hash)).toEqual(['0']);
    await expect(t.watch.check([auth('0', true), auth('44')], NOW)).resolves.toBe('NEW_PAUSED');
    expect(t.order).toEqual(['newAuthorization:44', 'newAuthorization:44', 'pause']);
  });

  it('a failed alert pauses nothing and remembers nothing (fail closed: the next round retries)', async () => {
    const t = setup();
    await t.known.remember([auth('0', true)]);
    t.notifier.alert.mockRejectedValueOnce(new Error('redis away'));
    await expect(t.watch.check([auth('0', true), auth('44')], NOW)).rejects.toThrow();
    expect(t.pauser.pauseAll).not.toHaveBeenCalled();
    expect(t.known.rows).toHaveLength(1);
  });
});
