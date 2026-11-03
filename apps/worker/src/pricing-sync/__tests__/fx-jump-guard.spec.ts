import { FX_MAX_JUMP_BPS } from '@repo/shared';
import { exceedsJumpLimit } from '../fx-jump-guard';

describe('exceedsJumpLimit', () => {
  it('uses the shared 10% limit by default', () => {
    expect(FX_MAX_JUMP_BPS).toBe(1000);
  });

  it.each([
    ['USDT_UZS', '12650', '13915', false], // +10.000% exactly
    ['USDT_UZS', '12650', '13915.01', true],
    ['USDT_UZS', '12650', '11385', false], // −10.000% exactly
    ['USDT_UZS', '12650', '11384.99', true],
    ['TON_USDT', '3.2', '3.52', false],
    ['TON_USDT', '3.2', '3.520000000001', true],
    ['TON_USDT', '3.2', '2.88', false],
    ['TON_USDT', '3.2', '2.879999999999', true],
    ['TON_UZS', '40480', '40480', false],
    ['TON_UZS', '40480', '0.5', true],
  ] as const)('%s %s → %s: blocked=%s', (pair, previous, next, blocked) => {
    expect(exceedsJumpLimit(pair, previous, next)).toBe(blocked);
  });

  it('compares rates with many decimals exactly (no float rounding)', () => {
    // 0.1 + 0.2 style float error would flip these; BigInt keeps them exact.
    expect(exceedsJumpLimit('TON_USDT', '0.3', '0.33')).toBe(false);
    expect(exceedsJumpLimit('TON_USDT', '0.3', '0.33000000000001')).toBe(true);
    expect(exceedsJumpLimit('TON_USDT', '0.000000000001', '0.0000000000011')).toBe(false);
    expect(exceedsJumpLimit('TON_USDT', '0.000000000001', '0.00000000000111')).toBe(true);
  });

  it('honours a custom limit', () => {
    expect(exceedsJumpLimit('USDT_UZS', '100', '101', 100)).toBe(false);
    expect(exceedsJumpLimit('USDT_UZS', '100', '101.01', 100)).toBe(true);
    expect(exceedsJumpLimit('USDT_UZS', '100', '100.01', 0)).toBe(true);
  });
});
