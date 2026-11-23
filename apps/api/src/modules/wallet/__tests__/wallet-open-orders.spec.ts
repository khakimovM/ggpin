import { THRESHOLD, setup } from './wallet-admin.fixtures';
import {
  adjustBindingFlags,
  adjustOtpFlags,
  recentSetHash,
  refuseUnconfirmedSets,
} from '../wallet-admin.input';
import {
  checkedOpenOrdersSet,
  openOrdersConfirmed,
  openOrdersFlag,
  openOrdersSetHash,
  type OpenOrder,
} from '../wallet-open-orders';

// I-5 (owner decision 2026-11-22): a positive adjustment for a user with open orders needs the id
// of exactly that set, checked under the wallet lock; a debit never reads them.

const order = (id: string, status: OpenOrder['status'] = 'HELD'): OpenOrder => ({
  id,
  number: 7,
  status,
  priceTiyin: 1_600_000n,
  createdAt: new Date('2026-11-22T09:00:00.000Z'),
});
const OPEN = [order('o1'), order('o2', 'PAID')];
const OTP = { challengeId: 'c'.repeat(32), code: '123456' };
const input = { userId: 'u1', amountTiyin: 500_000n, reason: 'support credit', operator: 'aziz' };

describe('open-orders set id', () => {
  it('is 12 hex of all the sorted ids: order-independent, changes with any id', () => {
    const set = openOrdersSetHash(OPEN);
    expect(set).toMatch(/^[0-9a-f]{12}$/);
    expect(openOrdersSetHash([...OPEN].reverse())).toBe(set);
    expect(openOrdersSetHash([order('o1')])).not.toBe(set);
    expect(openOrdersSetHash([...OPEN, order('o3')])).not.toBe(set);
  });

  it('never equals the top-up set id of the same ids (domain separated)', () => {
    const ids = [{ id: 'x1', amountTiyin: 0n, confirmedAt: null }];
    expect(openOrdersSetHash(ids)).not.toBe(recentSetHash(ids));
  });

  it('confirmed (credit): nothing open and no set, or exactly the set read now', () => {
    expect(openOrdersConfirmed(1n, [], undefined)).toBe(true);
    expect(openOrdersConfirmed(1n, OPEN, undefined)).toBe(false);
    expect(openOrdersConfirmed(1n, OPEN, openOrdersSetHash([order('o1')]))).toBe(false);
    expect(openOrdersConfirmed(1n, OPEN, openOrdersSetHash(OPEN))).toBe(true);
  });

  it('CR #2: a given set must equal the current one even when nothing is open any more', () => {
    // The owner confirmed OPEN; both orders closed meanwhile (one auto-refunded): refused.
    expect(openOrdersConfirmed(1n, [], openOrdersSetHash(OPEN))).toBe(false);
    expect(openOrdersConfirmed(1n, [], 'abcdefabcdef')).toBe(false);
    // The empty set has its own id: only that one matches an empty read.
    expect(openOrdersSetHash([])).toMatch(/^[0-9a-f]{12}$/);
    expect(openOrdersConfirmed(1n, [], openOrdersSetHash([]))).toBe(true);
  });

  it('a debit is never held back, whatever was sent with it', () => {
    for (const amount of [0n, -1n]) {
      expect(openOrdersConfirmed(amount, OPEN, undefined)).toBe(true);
      expect(openOrdersConfirmed(amount, [], openOrdersSetHash(OPEN))).toBe(true);
    }
  });

  it('takes only a 12-hex value', () => {
    expect(checkedOpenOrdersSet(undefined)).toBeUndefined();
    expect(checkedOpenOrdersSet('0123456789ab')).toBe('0123456789ab');
    for (const bad of ['', 'ABCDEF012345', '0123456789a', '0123456789abc', 'zzzzzzzzzzzz']) {
      expect(() => checkedOpenOrdersSet(bad)).toThrow();
    }
  });
});

describe('refuseUnconfirmedSets (the action under the lock and POST /admin/confirmations)', () => {
  const recent = [{ id: 'p1', amountTiyin: 100n, confirmedAt: null }];
  const none = { recent: [], overrideSet: undefined, open: [], openSet: undefined };
  /** The refusal's field and reason, or null when the sets pass. */
  const refusalOf = (amount: bigint, sets: Parameters<typeof refuseUnconfirmedSets>[1]) => {
    try {
      refuseUnconfirmedSets(amount, sets);
      return null;
    } catch (error) {
      return (error as { details?: unknown }).details;
    }
  };
  const refusal = (code: string) => ({ field: 'user', reason: code });

  it('passes with nothing to confirm, or with both exact sets', () => {
    expect(() => refuseUnconfirmedSets(1n, none)).not.toThrow();
    const both = {
      recent,
      overrideSet: recentSetHash(recent),
      open: OPEN,
      openSet: openOrdersSetHash(OPEN),
    };
    expect(() => refuseUnconfirmedSets(1n, both)).not.toThrow();
  });

  it('RECENT_AUTO_TOPUP: top-ups without the override or with a stale one', () => {
    expect(refusalOf(1n, { ...none, recent })).toEqual(refusal('RECENT_AUTO_TOPUP'));
    const stale = { ...none, recent, overrideSet: 'abcdefabcdef' };
    expect(refusalOf(1n, stale)).toEqual(refusal('RECENT_AUTO_TOPUP'));
  });

  it('OPEN_ORDERS: missing, stale, or given when nothing is open any more (CR #2)', () => {
    for (const sets of [
      { ...none, open: OPEN },
      { ...none, open: OPEN, openSet: openOrdersSetHash([order('o1')]) },
      { ...none, openSet: openOrdersSetHash(OPEN) },
    ]) {
      expect(refusalOf(1n, sets)).toEqual(refusal('OPEN_ORDERS'));
    }
  });

  it('the top-ups are checked first; a debit is never refused for open orders', () => {
    const both = { ...none, recent, open: OPEN };
    expect(refusalOf(1n, both)).toEqual(refusal('RECENT_AUTO_TOPUP'));
    expect(refusalOf(-1n, { ...none, openSet: openOrdersSetHash(OPEN) })).toBeNull();
  });
});

describe('binding flags', () => {
  it('without open orders the flag string is exactly the pre-S7a one (CLI binding unchanged)', () => {
    const recent = [{ id: 'p1', amountTiyin: 100n, confirmedAt: null }];
    expect(adjustBindingFlags(recent, true, [])).toBe(adjustOtpFlags(recent, true));
    expect(adjustBindingFlags([], false, [])).toBe('');
  });

  it('names the count and the set; joined to the override flag by "; "', () => {
    const recent = [{ id: 'p1', amountTiyin: 100n, confirmedAt: null }];
    expect(openOrdersFlag(OPEN)).toBe(
      `open orders: 2 open order(s), set ${openOrdersSetHash(OPEN)}`,
    );
    expect(adjustBindingFlags(recent, true, OPEN)).toBe(
      `${adjustOtpFlags(recent, true)}; ${openOrdersFlag(OPEN)}`,
    );
    expect(adjustBindingFlags([], false, OPEN)).toBe(openOrdersFlag(OPEN));
  });
});

describe('WalletAdminService.adjust with open orders (I-5)', () => {
  it('a positive adjustment without the set: refused under the lock, nothing written', async () => {
    const { service, repo } = setup();
    repo.openOrders.mockResolvedValue(OPEN);
    await expect(service.adjust(input)).rejects.toMatchObject({
      details: { field: 'user', reason: 'OPEN_ORDERS' },
    });
    expect(repo.lock).toHaveBeenCalled();
    expect(repo.createAudit).not.toHaveBeenCalled();
    expect(repo.appendEntry).not.toHaveBeenCalled();
  });

  it('a stale set is refused; the exact set is written and named in AuditLog.after', async () => {
    const { service, repo } = setup();
    repo.openOrders.mockResolvedValue(OPEN);
    const stale = openOrdersSetHash([order('o1')]);
    await expect(service.adjust({ ...input, confirmOpenOrdersSet: stale })).rejects.toMatchObject({
      details: { reason: 'OPEN_ORDERS' },
    });
    expect(repo.appendEntry).not.toHaveBeenCalled();
    const done = await service.adjust({ ...input, confirmOpenOrdersSet: openOrdersSetHash(OPEN) });
    expect(done.applied).toBe(true);
    expect(repo.createAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        after: expect.objectContaining({ openOrders: ['o1', 'o2'] }) as unknown,
      }),
    );
  });

  it('CR #2: the confirmed order closed before the lock (auto-refund): refused, nothing written', async () => {
    const { service, repo } = setup();
    // The set the owner saw had o1; under the lock nothing is open any more.
    repo.openOrders.mockResolvedValue([]);
    const seen = openOrdersSetHash([order('o1')]);
    await expect(service.adjust({ ...input, confirmOpenOrdersSet: seen })).rejects.toMatchObject({
      details: { field: 'user', reason: 'OPEN_ORDERS' },
    });
    expect(repo.lock).toHaveBeenCalled();
    expect(repo.createAudit).not.toHaveBeenCalled();
    expect(repo.appendEntry).not.toHaveBeenCalled();
  });

  it('CR #4: the sets are read inside the transaction, with its tx', async () => {
    const { service, repo } = setup();
    const TX = { $queryRaw: jest.fn().mockResolvedValue([]), $executeRaw: jest.fn() };
    repo.transaction.mockImplementation((fn: (tx: object) => Promise<unknown>) => fn(TX));
    repo.openOrders.mockResolvedValue(OPEN);
    await service.adjust({ ...input, confirmOpenOrdersSet: openOrdersSetHash(OPEN) });
    expect(repo.openOrders).toHaveBeenLastCalledWith('u1', TX);
    expect(repo.recentAutoTopups).toHaveBeenLastCalledWith('u1', expect.any(Date), TX);
    expect(repo.lock).toHaveBeenCalledWith(TX, 'u1');
  });

  it('a debit sent with a set is not held back by it', async () => {
    const { service, repo } = setup();
    const done = await service.adjust({
      ...input,
      amountTiyin: -500_000n,
      confirmOpenOrdersSet: openOrdersSetHash(OPEN),
    });
    expect(done.applied).toBe(true);
    expect(repo.appendEntry).toHaveBeenCalled();
  });

  it('a debit never reads the open orders and is never held back by them', async () => {
    const { service, repo } = setup();
    repo.openOrders.mockResolvedValue(OPEN);
    const done = await service.adjust({ ...input, amountTiyin: -500_000n });
    expect(done.applied).toBe(true);
    expect(repo.openOrders).not.toHaveBeenCalled();
  });

  it('a malformed set is refused before any lock', async () => {
    const { service, repo } = setup();
    await expect(service.adjust({ ...input, confirmOpenOrdersSet: 'nope' })).rejects.toMatchObject({
      details: { field: 'confirmOpenOrdersSet' },
    });
    expect(repo.lock).not.toHaveBeenCalled();
  });

  it('the code is bound to the open set; a set change after the code is OTP_MISMATCH', async () => {
    const { service, repo, otp } = setup(THRESHOLD * 2n);
    const big = { ...input, amountTiyin: THRESHOLD + 1n, confirmAmountTiyin: THRESHOLD + 1n };
    const later = [...OPEN, order('o3')];
    repo.openOrders.mockResolvedValueOnce(OPEN).mockResolvedValueOnce(later);
    await expect(
      service.adjust({ ...big, otp: OTP, confirmOpenOrdersSet: openOrdersSetHash(later) }),
    ).rejects.toMatchObject({ details: { field: 'otp', reason: 'OTP_MISMATCH' } });
    expect(otp.verifyIfGiven).toHaveBeenLastCalledWith(
      OTP,
      THRESHOLD + 1n,
      'wallet:adjust',
      'user u1 key -',
      openOrdersFlag(OPEN),
    );
    expect(repo.appendEntry).not.toHaveBeenCalled();
  });
});
