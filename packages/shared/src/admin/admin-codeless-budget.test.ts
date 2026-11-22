import { describe, expect, it } from 'vitest';
import {
  ADMIN_CODELESS_DAILY_MAX_COUNT,
  ADMIN_CODELESS_DAILY_MAX_TIYIN,
  codelessBudgetExceeded,
} from './admin-codeless-budget';
import { ADMIN_ADJUST_MAX_TIYIN, AdminAdjustAmountSchema } from './admin-common-schemas';

// Owner decision 2026-11-18 (SA-S6-3): 10 codeless debits/reversals and 2 000 000 so'm per admin
// per Tashkent day; the 11th action, or one that takes the sum above the cap, asks for the code.
describe('codelessBudgetExceeded', () => {
  it('the 10th action passes, the 11th asks', () => {
    expect(ADMIN_CODELESS_DAILY_MAX_COUNT).toBe(10);
    expect(codelessBudgetExceeded({ count: 9, sumTiyin: 0n }, -1n)).toBe(false);
    expect(codelessBudgetExceeded({ count: 10, sumTiyin: 0n }, -1n)).toBe(true);
  });

  it('exactly the sum cap passes (this action included), one tiyin more asks; sign ignored', () => {
    expect(ADMIN_CODELESS_DAILY_MAX_TIYIN).toBe(200_000_000n);
    const used = { count: 3, sumTiyin: 150_000_000n };
    expect(codelessBudgetExceeded(used, -50_000_000n)).toBe(false);
    expect(codelessBudgetExceeded(used, 50_000_000n)).toBe(false);
    expect(codelessBudgetExceeded(used, -50_000_001n)).toBe(true);
  });
});

describe('AdminAdjustAmountSchema (SA-S6-6)', () => {
  it('1 000 000 000 so’m either way at most, never zero', () => {
    expect(ADMIN_ADJUST_MAX_TIYIN).toBe(100_000_000_000n);
    expect(AdminAdjustAmountSchema.safeParse('100000000000').success).toBe(true);
    expect(AdminAdjustAmountSchema.safeParse('-100000000000').success).toBe(true);
    expect(AdminAdjustAmountSchema.safeParse('100000000001').success).toBe(false);
    expect(AdminAdjustAmountSchema.safeParse('-100000000001').success).toBe(false);
    expect(AdminAdjustAmountSchema.safeParse('0').success).toBe(false);
  });
});
