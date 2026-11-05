import { describe, expect, it } from 'vitest';
import {
  BANK_FEED_HEARTBEAT_KEY,
  BANK_FEED_LEADER_KEY,
  WALLET_CACHE_TTL_SEC,
  decodeCachedBalance,
  encodeCachedBalance,
  walletCacheKey,
} from './cache-keys';
import {
  LEDGER_KINDS,
  LedgerItemSchema,
  LedgerQuerySchema,
  WalletResponseSchema,
  isLedgerAmountAllowed,
} from './ledger-schemas';

describe('walletCacheKey', () => {
  it('is wallet:{userId}', () => {
    expect(walletCacheKey('cm0user1')).toBe('wallet:cm0user1');
  });

  it('refuses an id that could leave the key namespace', () => {
    for (const bad of ['', 'a:b', 'a b', 'x\n', '*']) {
      expect(() => walletCacheKey(bad)).toThrow();
    }
  });

  it('exposes the bank-feed keys the worker writes and the API reads', () => {
    expect(BANK_FEED_HEARTBEAT_KEY).toBe('bankfeed:heartbeat');
    expect(BANK_FEED_LEADER_KEY).toBe('lock:bank-feed');
    expect(WALLET_CACHE_TTL_SEC).toBe(60);
  });
});

describe('cached balance codec', () => {
  it('round-trips zero, positive and negative balances', () => {
    for (const value of [0n, 1n, 2034100n, -550000n, 2n ** 62n]) {
      expect(decodeCachedBalance(encodeCachedBalance(value))).toBe(value);
    }
  });

  it('reads a missing or corrupt entry as a cache miss, never as a balance', () => {
    for (const raw of [
      null,
      undefined,
      '',
      'NaN',
      '1.5',
      '01',
      '-0',
      '1e3',
      ' 5',
      '9'.repeat(20),
    ]) {
      expect(decodeCachedBalance(raw)).toBeNull();
    }
  });
});

describe('isLedgerAmountAllowed (mirrors the LedgerEntry CHECK)', () => {
  const EXPECTED = {
    TOPUP: [1n, -1n, 0n],
    REFUND: [1n, -1n, 0n],
    REFERRAL_BONUS: [1n, -1n, 0n],
    TOPUP_REVERSAL: [-1n, 1n, 0n],
    PURCHASE: [-1n, 1n, 0n],
    REFERRAL_BONUS_REVERSAL: [-1n, 1n, 0n],
    ADJUSTMENT: [1n, -1n, 0n],
  } as const;

  it('covers every kind', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...LEDGER_KINDS].sort());
  });

  it.each(LEDGER_KINDS)('%s: right sign passes, wrong sign and zero follow the table', (kind) => {
    const [ok, wrong, zero] = EXPECTED[kind];
    expect(isLedgerAmountAllowed(kind, ok)).toBe(true);
    expect(isLedgerAmountAllowed(kind, zero)).toBe(false);
    // ADJUSTMENT accepts either sign; everything else refuses the opposite one.
    expect(isLedgerAmountAllowed(kind, wrong)).toBe(kind === 'ADJUSTMENT');
  });
});

describe('wallet and ledger schemas', () => {
  it('WalletResponseSchema: strings, signed balance, UZS only', () => {
    expect(
      WalletResponseSchema.safeParse({ balanceTiyin: '1255000', coins: '0', currency: 'UZS' })
        .success,
    ).toBe(true);
    expect(
      WalletResponseSchema.safeParse({ balanceTiyin: '-100', coins: '5', currency: 'UZS' }).success,
    ).toBe(true);
    for (const bad of [
      { balanceTiyin: 1255000, coins: '0', currency: 'UZS' },
      { balanceTiyin: '-0', coins: '0', currency: 'UZS' },
      { balanceTiyin: '1', coins: '-1', currency: 'UZS' },
      { balanceTiyin: '1', coins: '0', currency: 'USD' },
    ]) {
      expect(WalletResponseSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('coins are bounded like money, and the object is strict', () => {
    const wallet = (extra: Record<string, unknown>) =>
      WalletResponseSchema.safeParse({ balanceTiyin: '1', coins: '0', currency: 'UZS', ...extra });
    expect(wallet({ coins: '9223372036854775807' }).success).toBe(true);
    expect(wallet({ coins: '9223372036854775808' }).success).toBe(false);
    expect(wallet({ coins: '1.5' }).success).toBe(false);
    expect(wallet({ userId: 'u1' }).success).toBe(false);
  });

  it('SignedTiyin bounds: BIGINT range only', () => {
    const wallet = (balanceTiyin: string) =>
      WalletResponseSchema.safeParse({ balanceTiyin, coins: '0', currency: 'UZS' }).success;
    expect(wallet('9223372036854775807')).toBe(true);
    expect(wallet('-9223372036854775807')).toBe(true);
    expect(wallet('9223372036854775808')).toBe(false);
    expect(wallet('-9223372036854775808')).toBe(false);
  });

  it('LedgerQuerySchema: kind filter, page and limit defaults and bounds', () => {
    expect(LedgerQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
    expect(LedgerQuerySchema.parse({ kind: 'TOPUP', page: '2', limit: '100' })).toEqual({
      kind: 'TOPUP',
      page: 2,
      limit: 100,
    });
    for (const bad of [{ kind: 'NOPE' }, { limit: '101' }, { page: '0' }, { x: '1' }]) {
      expect(LedgerQuerySchema.safeParse(bad).success).toBe(false);
    }
  });

  it('LedgerItemSchema: ids are null unless the entry came from that kind of source', () => {
    const item = {
      id: 'l1',
      kind: 'PURCHASE',
      amountTiyin: '-550000',
      createdAt: '2026-11-04T10:00:00.000Z',
      orderId: 'o1',
      paymentId: null,
    };
    expect(LedgerItemSchema.safeParse(item).success).toBe(true);
    expect(LedgerItemSchema.safeParse({ ...item, amountTiyin: -550000 }).success).toBe(false);
    expect(LedgerItemSchema.safeParse({ ...item, orderId: undefined }).success).toBe(false);
    // ids are resource ids (no whitespace or control characters) and the item is strict
    expect(LedgerItemSchema.safeParse({ ...item, id: 'a b' }).success).toBe(false);
    expect(LedgerItemSchema.safeParse({ ...item, orderId: 'x\n' }).success).toBe(false);
    expect(LedgerItemSchema.safeParse({ ...item, refId: 'audit1' }).success).toBe(false);
  });
});
