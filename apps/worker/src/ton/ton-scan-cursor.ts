import type { Prisma } from '@repo/db';
import { z } from 'zod';
import type { TonAccountState, TonTxRef } from './ton-gateway';
import type { ScanAnchor, ScanProgress } from './ton-tx-scan';

// The primary source's scan progress of one ORDER transfer, kept in the database across restarts
// (phase 5 S9, L-2, D-64 (2), Q-14) as `FulfillmentAttempt.response.ton.scan`: a NEEDS_REVIEW
// transfer may be watched for days, and a restart must not read the whole spammed window again.
//
// Trust: the cursor says "this part of the wallet's history was read and our message is not in
// it". A forged one could hide our transaction from the scan, so it lives in the database next to
// the other evidence (never Redis), is bound to the transfer AND its signed message (a cursor of
// another transfer or message counts as none, like a kept expiry observation, audit L-3), and is
// parsed strictly (an unreadable cursor counts as none: the scan starts over, the safe direction).
// Even a lying cursor cannot turn a payout that went out into EXPIRED: our message moves the
// wallet's seqno, and an EXPIRY observation needs the seqno unchanged in a fresh state (S5).

const HASH = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9]\d{0,19})$/;
/** A W5 data cell is about a hundred bytes; anything far bigger is not one. */
const MAX_DATA_BASE64 = 4_096;

const TxRefJson = z.strictObject({ lt: z.string().regex(DECIMAL), hash: z.string().regex(HASH) });

const StateJson = z.strictObject({
  status: z.enum(['active', 'uninitialized', 'frozen']),
  balanceNano: z.string().regex(DECIMAL),
  data: z.base64().max(MAX_DATA_BASE64).nullable(),
  chainTime: z.number().int().positive(),
  lastTx: TxRefJson.nullable(),
});

const CursorJson = z.strictObject({
  transferId: z.string().min(1).max(64),
  extMsgHash: z.string().regex(HASH),
  covered: TxRefJson.nullable(),
  pass: z
    .strictObject({
      anchor: z.strictObject({
        state: StateJson,
        atMs: z.number().int().positive().nullable(),
      }),
      next: TxRefJson,
    })
    .nullable(),
});

const StoredScanJson = z.object({ ton: z.object({ scan: z.unknown() }) });

/** The transfer and the message a cursor is about. */
export interface ScanBinding {
  readonly id: string;
  readonly extMsgHash: string;
}

type TxRefJsonValue = z.infer<typeof TxRefJson>;

function refJson(ref: TonTxRef): TxRefJsonValue {
  return { lt: ref.lt.toString(), hash: ref.hash };
}

function refOf(json: TxRefJsonValue): TonTxRef {
  return { lt: BigInt(json.lt), hash: json.hash };
}

function stateJson(state: TonAccountState): Prisma.InputJsonObject {
  return {
    status: state.status,
    balanceNano: state.balanceNano.toString(),
    data: state.data === null ? null : state.data.toString('base64'),
    chainTime: state.chainTime,
    lastTx: state.lastTx === null ? null : refJson(state.lastTx),
  };
}

/** The JSON kept under `response.ton.scan` for this transfer's progress. */
export function scanCursorJson(
  transfer: ScanBinding,
  progress: ScanProgress,
): Prisma.InputJsonObject {
  const pass = progress.pass;
  return {
    transferId: transfer.id,
    extMsgHash: transfer.extMsgHash,
    covered: progress.covered === null ? null : refJson(progress.covered),
    pass:
      pass === null
        ? null
        : {
            anchor: { state: stateJson(pass.anchor.state), atMs: pass.anchor.atMs },
            next: refJson(pass.next),
          },
  };
}

/** Two progresses are the same cursor (nothing new to keep). */
export function sameScanCursor(
  transfer: ScanBinding,
  a: ScanProgress | null,
  b: ScanProgress | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    JSON.stringify(scanCursorJson(transfer, a)) === JSON.stringify(scanCursorJson(transfer, b))
  );
}

/**
 * A pass in flight walks DOWN from its anchor's last transaction, and what an earlier pass covered
 * lies below the anchor: a cursor that says otherwise was not written by the scan.
 */
function consistent(progress: ScanProgress): boolean {
  const pass = progress.pass;
  if (pass === null) return true;
  const last = pass.anchor.state.lastTx;
  if (last === null || pass.next.lt > last.lt) return false;
  return progress.covered === null || progress.covered.lt < pass.next.lt;
}

/**
 * The progress kept in an attempt's response for exactly this transfer and message, or null:
 * none, unreadable, bound to another transfer or message, or inconsistent (dropped: the scan
 * starts over).
 */
export function storedScanProgress(response: unknown, transfer: ScanBinding): ScanProgress | null {
  const stored = StoredScanJson.safeParse(response);
  if (!stored.success) return null;
  const parsed = CursorJson.safeParse(stored.data.ton.scan);
  if (!parsed.success) return null;
  const cursor = parsed.data;
  if (cursor.transferId !== transfer.id || cursor.extMsgHash !== transfer.extMsgHash) return null;
  const pass = cursor.pass;
  const anchor: ScanAnchor | null =
    pass === null
      ? null
      : {
          state: {
            status: pass.anchor.state.status,
            balanceNano: BigInt(pass.anchor.state.balanceNano),
            data:
              pass.anchor.state.data === null
                ? null
                : Buffer.from(pass.anchor.state.data, 'base64'),
            chainTime: pass.anchor.state.chainTime,
            lastTx: pass.anchor.state.lastTx === null ? null : refOf(pass.anchor.state.lastTx),
          },
          atMs: pass.anchor.atMs,
        };
  const progress: ScanProgress = {
    covered: cursor.covered === null ? null : refOf(cursor.covered),
    pass: pass === null || anchor === null ? null : { anchor, next: refOf(pass.next) },
  };
  return consistent(progress) ? progress : null;
}
