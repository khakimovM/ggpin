import type { Tx } from '@repo/db';
import { TON_NOT_SENT_MARGIN_MS } from '@repo/shared';
import {
  writeOutcome,
  type OutcomeRows,
  type SelftestExpiryMemory,
  type TonOutcome,
} from '../ton-outcome-writes';

// A SELFTEST transfer (no order, no attempt) keeps its first observation and a witness conflict in
// the memory of the one CLI process watching it. Review RR2-4: after the conflict two consistent
// observations write nothing; without one, the second writes EXPIRED (D-60 (2)). The ORDER path is
// proven on the real database (ton-witness-conflict.e2e-spec.ts).

const VALID_UNTIL_MS = 1_800_000_060_000;
const MARGIN_SEC = TON_NOT_SENT_MARGIN_MS / 1_000;
const ROWS: OutcomeRows = {
  transferId: 'cm0selftest1',
  transfer: 'BROADCAST',
  orderId: null,
  order: null,
  attemptId: null,
  attempt: null,
};

function look(laterSec: number): TonOutcome {
  return {
    kind: 'EXPIRY_SEEN',
    gapSec: 30,
    observation: {
      transferId: ROWS.transferId,
      extMsgHash: 'ab'.repeat(32),
      validUntilMs: VALID_UNTIL_MS,
      chainTime: VALID_UNTIL_MS / 1_000 + MARGIN_SEC + 1 + laterSec,
      atMs: VALID_UNTIL_MS + TON_NOT_SENT_MARGIN_MS + laterSec * 1_000,
      seqno: 3,
      lastTxLt: 0n,
    },
  };
}

/** Records the transfer updates; any other use of the transaction fails the test. */
function recordingTx(): { tx: Tx; updates: unknown[] } {
  const updates: unknown[] = [];
  const tonTransfer = {
    update: (args: unknown) => {
      updates.push(args);
      return Promise.resolve({});
    },
  };
  const tx = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === 'tonTransfer') return tonTransfer;
        throw new Error(`unexpected tx.${String(key)}`);
      },
    },
  );
  return { tx: tx as unknown as Tx, updates };
}

const memory = (): SelftestExpiryMemory => ({ firsts: new Map(), conflicts: new Set() });

describe('the SELFTEST expiry memory (review RR2-4)', () => {
  it('without a conflict: the first is kept, the second writes EXPIRED', async () => {
    const { tx, updates } = recordingTx();
    const kept = memory();
    expect(await writeOutcome(tx, ROWS, look(0), kept)).toBe(false);
    expect(kept.firsts.has(ROWS.transferId)).toBe(true);
    expect(await writeOutcome(tx, ROWS, look(30), kept)).toBe(true);
    expect(updates).toEqual([{ where: { id: ROWS.transferId }, data: { status: 'EXPIRED' } }]);
  });

  it('after a witness conflict: the kept first is dropped and two consistent looks write nothing', async () => {
    const { tx, updates } = recordingTx();
    const kept = memory();
    expect(await writeOutcome(tx, ROWS, look(0), kept)).toBe(false);
    const conflict: TonOutcome = { kind: 'WITNESS_CONFLICT', detail: 'FOUND', witness: 0 };
    expect(await writeOutcome(tx, ROWS, conflict, kept)).toBe(false);
    expect([kept.firsts.size, [...kept.conflicts]]).toEqual([0, [ROWS.transferId]]);
    expect(await writeOutcome(tx, ROWS, look(30), kept)).toBe(false);
    expect(await writeOutcome(tx, ROWS, look(60), kept)).toBe(false);
    expect(updates).toEqual([]);
  });
});
