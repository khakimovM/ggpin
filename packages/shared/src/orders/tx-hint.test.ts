import { describe, expect, it } from 'vitest';
import { TON_TX_HINT_ACTION, TonTxHintSchema } from './tx-hint';
import { ORDER_EFFECTS_ACTIONS } from './order-effects-plan';

// Synthetic values only.
const HASH = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0abcd';
const VALID = { transferId: 'ckt0000000000000000000009', txHash: HASH, lt: '47000000000001' };

describe('TON_TX_HINT (Z6, D-64 (7))', () => {
  it('is the audit action the effects plan knows', () => {
    expect(TON_TX_HINT_ACTION).toBe('TON_TX_HINT');
    expect(ORDER_EFFECTS_ACTIONS.tonTxHint).toBe(TON_TX_HINT_ACTION);
  });

  it('accepts a transfer id, a lowercase 64-hex hash and a positive decimal lt', () => {
    expect(TonTxHintSchema.parse(VALID)).toEqual(VALID);
    expect(TonTxHintSchema.safeParse({ ...VALID, lt: '18446744073709551615' }).success).toBe(true);
  });

  it('is strict: an extra key is refused', () => {
    expect(TonTxHintSchema.safeParse({ ...VALID, seqno: 5 }).success).toBe(false);
    expect(TonTxHintSchema.safeParse({ ...VALID, reason: 'x' }).success).toBe(false);
  });

  it.each([
    HASH.toUpperCase(),
    HASH.slice(1),
    `${HASH}0`,
    `${HASH.slice(0, 63)}g`,
    `0x${HASH.slice(2)}`,
    '',
  ])('refuses the hash %j', (txHash) => {
    expect(TonTxHintSchema.safeParse({ ...VALID, txHash }).success).toBe(false);
  });

  it.each(['0', '-1', '01', '1.5', '1e5', ' 1', 'abc', '', '18446744073709551616', '9'.repeat(21)])(
    'refuses the lt %j',
    (lt) => {
      expect(TonTxHintSchema.safeParse({ ...VALID, lt }).success).toBe(false);
    },
  );

  it('refuses a number lt and a transfer id that is not a cuid', () => {
    expect(TonTxHintSchema.safeParse({ ...VALID, lt: 47 }).success).toBe(false);
    for (const transferId of [
      '',
      'tr1',
      'CKT0000000000000000000009',
      'ckt-000000000000000000009',
    ]) {
      expect(TonTxHintSchema.safeParse({ ...VALID, transferId }).success).toBe(false);
    }
  });
});
