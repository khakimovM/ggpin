import { describe, expect, it } from 'vitest';
import { MoneyError } from '../money';
import { COST_CURRENCIES } from '../money-pricing';
import { exceedsCostCeiling, type StoredCostCeiling } from './cost-ceiling';
import { FULFILL_ORDER_LOCK_DURATION_MS } from './fulfill-order-config';
import { FULFILLMENT_ALERT_KINDS, FulfillmentAlertKindSchema } from './fulfillment-alerts';
import {
  ADAPTER_HEALTH_VALUES,
  FRAGMENT_HEALTH_KEY,
  FRAGMENT_HEALTH_VALUES,
  adapterHealthKey,
} from './health-keys';
import { ALERT_KINDS } from '../payments/bank-feed';

describe('health keys', () => {
  it('uses the names of the plan and the readiness contract', () => {
    expect(FRAGMENT_HEALTH_KEY).toBe('fragment:health');
    expect([...FRAGMENT_HEALTH_VALUES]).toEqual(['ok', 'down']);
    expect([...ADAPTER_HEALTH_VALUES]).toEqual(['OK', 'DEGRADED', 'DOWN']);
  });

  it('builds adapter:health:<code> and refuses a code that could leave the namespace', () => {
    expect(adapterHealthKey('FRAGMENT')).toBe('adapter:health:FRAGMENT');
    expect(adapterHealthKey('RESELLER_STARS')).toBe('adapter:health:RESELLER_STARS');
    for (const bad of ['', 'fragment', 'A:B', 'A B', '1ABC', 'A'.repeat(33), 'A*']) {
      expect(() => adapterHealthKey(bad)).toThrow();
    }
  });
});

describe('fulfillment alert kinds', () => {
  it('are a closed list that never repeats a bank-feed alert (one OwnerAlertKind namespace)', () => {
    expect(new Set(FULFILLMENT_ALERT_KINDS).size).toBe(FULFILLMENT_ALERT_KINDS.length);
    for (const kind of FULFILLMENT_ALERT_KINDS) {
      expect(ALERT_KINDS as readonly string[], kind).not.toContain(kind);
      expect(FulfillmentAlertKindSchema.safeParse(kind).success).toBe(true);
    }
    expect(FulfillmentAlertKindSchema.safeParse('noMatch').success).toBe(false);
  });

  it('has the critical key of a consumed seqno without a transaction of ours (owner decision R2)', () => {
    expect(FULFILLMENT_ALERT_KINDS).toContain('tonConsumedUnmatched');
  });

  it('has the keys of a bounced payment and of a compromised wallet (owner decisions A1, A3)', () => {
    expect(FULFILLMENT_ALERT_KINDS).toContain('tonBounced');
    expect(FULFILLMENT_ALERT_KINDS).toContain('tonWalletCompromised');
  });
});

describe('the stored cost ceiling (I4)', () => {
  const ceiling: StoredCostCeiling = {
    costCurrency: 'TON',
    costMinor: 1_000_000_000n,
    maxCostMinor: 1_030_000_000n,
  };

  it('allows exactly the ceiling and refuses one unit above', () => {
    const ton = (amountMinor: bigint) => ({ currency: 'TON', amountMinor }) as const;
    expect(exceedsCostCeiling(ceiling, ton(1_030_000_000n))).toBe(false);
    expect(exceedsCostCeiling(ceiling, ton(1_030_000_001n))).toBe(true);
    expect(exceedsCostCeiling(ceiling, ton(1n))).toBe(false);
  });

  it('refuses to compare another currency: the same number in USDT is not a TON amount (L5)', () => {
    for (const amountMinor of [1n, 1_030_000_000n, 9_999_999_999n]) {
      expect(() => exceedsCostCeiling(ceiling, { currency: 'USDT', amountMinor })).toThrow(
        MoneyError,
      );
    }
    const usdt = { ...ceiling, costCurrency: 'USDT' } as const;
    expect(() => exceedsCostCeiling(usdt, { currency: 'TON', amountMinor: 1n })).toThrow(
      MoneyError,
    );
    expect(exceedsCostCeiling(usdt, { currency: 'USDT', amountMinor: 1_030_000_001n })).toBe(true);
  });

  it('is in a cost currency the pricing module knows', () => {
    expect(COST_CURRENCIES).toContain(ceiling.costCurrency);
  });
});

describe('the lock duration that the "never sent" waiting period is built on', () => {
  it('is longer than the 3-minute confirmation wait (plan 6.4 step 7)', () => {
    expect(FULFILL_ORDER_LOCK_DURATION_MS).toBeGreaterThan(3 * 60_000);
  });
});
