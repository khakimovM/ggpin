import { report, type CliContext } from './commands/command';

// The late chain facts of an attempt as `order:show` prints them (phase 5 S9f): found late, bounced
// late, the destination's late verdict, failed on the chain. Ids, codes and hashes only.

/** A field reader of the attempt's `ton.<key>` fact, or null when there is no such object. */
export function tonFact(response: unknown, key: string): ((field: string) => unknown) | null {
  if (typeof response !== 'object' || response === null) return null;
  const ton: unknown = Reflect.get(response, 'ton');
  if (typeof ton !== 'object' || ton === null) return null;
  const fact: unknown = Reflect.get(ton, key);
  if (typeof fact !== 'object' || fact === null) return null;
  return (field): unknown => {
    const value: unknown = Reflect.get(fact, field);
    return value;
  };
}

export const word = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '?';

/**
 * What a `late` fact means for the owner's next step. SEQNO_HELD (CR m3) and OTHER_TRANSFER (CR M2)
 * say the message PAID / reached the chain while the row still says "not sent": the owner's MANUAL
 * FAILED would still pass there (owner decision 3), so the note warns before anyone refunds.
 */
export function lateNoteOf(late: (field: string) => unknown): string {
  const outcome = late('outcome');
  if (outcome === 'SEQNO_HELD') {
    return `PAID as signed on the chain (another transfer held the seqno, so the row stays ${word(late('from'))}): the payout went out, do NOT refund it (MANUAL FAILED would still pass)`;
  }
  if (outcome === 'OTHER_TRANSFER') {
    return `the owner's hint for transfer ${word(late('hintedTransferId'))} found THIS message on the chain (primary source): counted as paid, no refund proof may rest on it (MANUAL FAILED would still pass)`;
  }
  return 'counted NOT sent first, found on the chain later: the reconciler leaves this order to the owner';
}

export function printLateFacts(ctx: CliContext, response: unknown): void {
  const late = tonFact(response, 'late');
  if (late !== null) {
    report(ctx, {
      late: `from=${word(late('from'))} via=${word(late('via'))} outcome=${word(late('outcome'))} tx=${word(late('txHash'))}@${word(late('txLt'))}`,
      lateNote: lateNoteOf(late),
    });
  }
  const bounce = tonFact(response, 'lateBounce');
  if (bounce !== null) {
    report(ctx, {
      lateBounce: `txHash=${word(bounce('txHash'))} returnTxHash=${word(bounce('returnTxHash'))} returnLt=${word(bounce('returnLt'))} returnedNanoTon=${word(bounce('returnedNanoTon'))} orderStatus=${word(bounce('orderStatus'))}`,
    });
  }
  // CR M3: the destination aborted a CONFIRMED transfer, or its transaction did not pay as signed.
  const destination = tonFact(response, 'lateDestination');
  if (destination !== null) {
    const destTxHash = destination('destTxHash');
    report(ctx, {
      lateDestination: `verdict=${word(destination('verdict'))} destTxHash=${destTxHash === null ? '-' : word(destTxHash)} orderStatus=${word(destination('orderStatus'))}`,
    });
  }
  const failed = tonFact(response, 'onchainFailed');
  if (failed !== null) {
    report(ctx, {
      onchainFailed: `txHash=${word(failed('txHash'))} txLt=${word(failed('txLt'))} outMsgCount=${word(failed('outMsgCount'))} sources=${word(failed('sources'))}`,
    });
  }
}
