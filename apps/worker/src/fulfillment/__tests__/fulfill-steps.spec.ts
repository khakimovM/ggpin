import type { AttemptStatus } from '@repo/db';
import { NeedsReviewProofSchema } from '@repo/shared';
import { beginCell } from '@ton/core';
import type { PreparedFulfillment } from '../../adapters/fulfillment-adapter';
import {
  MAX_SEND_ATTEMPTS,
  isFinalAttempt,
  isLiveAttempt,
  judgePrepared,
  purchaseAmountOf,
  supplierNotSentProven,
  tonInstructionOf,
} from '../fulfill-steps';

const PAYLOAD = beginCell().storeUint(0, 32).endCell().toBoc().toString('base64');
const TON_ORDER = { costCurrency: 'TON', costMinor: 1_000n, maxCostMinor: 1_100n } as const;
const USDT_ORDER = { costCurrency: 'USDT', costMinor: 1_000n, maxCostMinor: 1_100n } as const;
const PAYEE = `0:${'ab'.repeat(32)}`;
const LIMITS = { supplierMaxPerOrderMicroUsdt: 1_050n, payAddresses: new Set([PAYEE]) };
const HOLD_ADAPTER_ERROR: unknown = expect.objectContaining({
  kind: 'HOLD',
  reason: 'ADAPTER_ERROR',
});

function tonPrepared(amount: bigint, overrides: Partial<PreparedFulfillment> = {}) {
  return {
    adapter: 'FRAGMENT',
    costCurrency: 'TON',
    costMinor: amount,
    request: { ton: { toAddress: PAYEE, amountNano: amount.toString(), payloadBoc: PAYLOAD } },
    externalRef: null,
    ...overrides,
  } satisfies PreparedFulfillment;
}

function usdtPrepared(amount: bigint, externalRef: string | null = 'sup-1') {
  return {
    adapter: 'RESELLER_STARS',
    costCurrency: 'USDT',
    costMinor: amount,
    request: {},
    externalRef,
  } satisfies PreparedFulfillment;
}

describe('judgePrepared: what may get a SENDING row (rules/45 steps 3-5)', () => {
  it('the stored ceiling: equal to maxCostMinor passes, one unit more is PRICE_ABOVE_MAX', () => {
    expect(judgePrepared(TON_ORDER, tonPrepared(1_100n), LIMITS)).toEqual({ kind: 'SEND' });
    expect(judgePrepared(TON_ORDER, tonPrepared(1_101n), LIMITS)).toEqual(
      expect.objectContaining({ kind: 'HOLD', reason: 'PRICE_ABOVE_MAX' }),
    );
  });

  it('another currency than the order is NO_ADAPTER, never compared across currencies', () => {
    expect(judgePrepared(TON_ORDER, usdtPrepared(1n), LIMITS)).toEqual(
      expect.objectContaining({ kind: 'HOLD', reason: 'NO_ADAPTER' }),
    );
  });

  it('a TON payout needs a valid instruction with exactly the prepared amount and no ref', () => {
    expect(judgePrepared(TON_ORDER, tonPrepared(1_000n, { request: {} }), LIMITS)).toEqual(
      HOLD_ADAPTER_ERROR,
    );
    const other = tonPrepared(999n);
    expect(judgePrepared(TON_ORDER, { ...other, costMinor: 1_000n }, LIMITS)).toEqual(
      HOLD_ADAPTER_ERROR,
    );
    expect(judgePrepared(TON_ORDER, tonPrepared(1_000n, { externalRef: 'x' }), LIMITS)).toEqual(
      HOLD_ADAPTER_ERROR,
    );
    expect(judgePrepared(TON_ORDER, tonPrepared(0n), LIMITS)).toEqual(HOLD_ADAPTER_ERROR);
  });

  it('a TON payee outside the allowlist, not workchain 0, or a payload that is no BOC: held', () => {
    const ton = (patch: Record<string, string>) =>
      tonPrepared(1_000n, {
        request: {
          ton: { toAddress: PAYEE, amountNano: '1000', payloadBoc: PAYLOAD, ...patch },
        },
      });
    const verdict = (patch: Record<string, string>) => judgePrepared(TON_ORDER, ton(patch), LIMITS);
    expect(verdict({})).toEqual({ kind: 'SEND' });
    const patches: Record<string, string>[] = [
      { toAddress: `0:${'cd'.repeat(32)}` },
      { toAddress: `-1:${'ab'.repeat(32)}` },
      { toAddress: 'not an address' },
      { payloadBoc: 'bm90IGEgYm9j' },
    ];
    for (const patch of patches) {
      expect({ patch, verdict: verdict(patch) }).toEqual({ patch, verdict: HOLD_ADAPTER_ERROR });
    }
  });

  it('a supplier payout: SUPPLIER_MAX_PER_ORDER exact passes, above is LIMIT_PER_ORDER', () => {
    expect(judgePrepared(USDT_ORDER, usdtPrepared(1_050n), LIMITS)).toEqual({ kind: 'SEND' });
    expect(judgePrepared(USDT_ORDER, usdtPrepared(1_051n), LIMITS)).toEqual(
      expect.objectContaining({ kind: 'HOLD', reason: 'LIMIT_PER_ORDER' }),
    );
  });

  it('a supplier payout without a precomputed reference is refused', () => {
    for (const ref of [null, '', '  ']) {
      expect(judgePrepared(USDT_ORDER, usdtPrepared(1_000n, ref), LIMITS)).toEqual(
        expect.objectContaining({ kind: 'HOLD', reason: 'ADAPTER_ERROR' }),
      );
    }
  });
});

describe('fulfill steps: small rules', () => {
  it('reads a TON instruction only in its exact shape', () => {
    const ton = { toAddress: '0:ab', amountNano: '5', payloadBoc: PAYLOAD };
    expect(tonInstructionOf({ ton })).toEqual(ton);
    expect(tonInstructionOf({ ton: { ...ton, amountNano: '05' } })).toBeNull();
    expect(tonInstructionOf({ ton: { ...ton, amountNano: '-5' } })).toBeNull();
    expect(tonInstructionOf({ ton: { ...ton, extra: 1 } })).toBeNull();
    expect(tonInstructionOf(null)).toBeNull();
    expect(tonInstructionOf([ton])).toBeNull();
  });

  it('the last BullMQ attempt is attemptsMade + 1 = attempts', () => {
    expect(isFinalAttempt(0, 5)).toBe(false);
    expect(isFinalAttempt(3, 5)).toBe(false);
    expect(isFinalAttempt(4, 5)).toBe(true);
    expect(isFinalAttempt(0, undefined)).toBe(true);
  });

  it('no supplier NOT_SENT proof is enough on its own: MANUAL is operator-only, TON is ours', () => {
    const hash = 'ab'.repeat(32);
    const proofs = [
      { kind: 'MANUAL', evidence: 'the supplier said so', reason: 'refused' },
      {
        kind: 'TON_NOT_DEBITED',
        transferId: 'cm9transfer00000000000001',
        txHash: hash,
        txLt: '1',
        outMsgCount: 0,
        reason: 'no outgoing message',
      },
      {
        kind: 'FRAGMENT_STATUS',
        requestRef: 'req-1',
        status: 'DONE',
        observedAt: '2026-11-14T00:00:00Z',
        reason: 'delivered',
      },
    ].map((candidate) => NeedsReviewProofSchema.parse(candidate));
    for (const proof of proofs) {
      expect({ kind: proof.kind, ok: supplierNotSentProven(proof) }).toEqual({
        kind: proof.kind,
        ok: false,
      });
    }
  });

  it('a live attempt is one that may have been sent', () => {
    const statuses: AttemptStatus[] = ['SENDING', 'SENT', 'UNKNOWN', 'CONFIRMED', 'FAILED'];
    expect(statuses.filter(isLiveAttempt)).toEqual(['SENDING', 'SENT', 'UNKNOWN']);
  });

  it('the PURCHASE entry carries minus what was paid; two send attempts at most', () => {
    expect(purchaseAmountOf({ priceTiyin: 5_000n, discountTiyin: 500n })).toBe(-4_500n);
    expect(MAX_SEND_ATTEMPTS).toBe(2);
  });
});
