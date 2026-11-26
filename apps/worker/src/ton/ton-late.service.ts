import { Inject, Injectable, Logger } from '@nestjs/common';
import { hasLateTonFact, type TonTransferStatus } from '@repo/db';
import type { Address } from '@ton/core';
import { parseTonAddress } from './ton-address';
import { classifyDestination, classifyOurTx } from './ton-classifier';
import { factsOf, failedSuspectOf } from './ton-late-facts';
import { LookCounter, foreignRef, hintDestination, isTransientRefusal } from './ton-late-hint';
import { TonLateReader } from './ton-late-reader';
import { TonLateRepository, type LateTransfer } from './ton-late.repository';
import { LateWriter, nothing, wait, type LateCheck } from './ton-late-writer';
import type { LateOutcome } from './ton-late-writes';
import type { TonNotice } from './ton-notices';
import { TonNotifier } from './ton-notifier';
import { checkOnchainFailed } from './ton-onchain-failed';
import {
  TON_HOT_WALLET_ADDRESS,
  TON_PAY_ADDRESSES,
  TON_TIMING,
  type TonHotWalletAddress,
  type TonPayAddresses,
  type TonTiming,
} from './ton-tokens';
import { checkHint } from './ton-tx-hint.verifier';

// The late chain facts of the TON module (phase 5 S9f, D-64 (7)), one transfer per call, called by
// the order reconciler's late-facts step under `lock:order:{id}`. Each call reads the chain
// (TonLateReader), decides with the pure checks and writes through TonLateRepository (one
// transaction, order -> attempt -> transfer); the notices go AFTER the commit, with stable ids.
// Nothing here signs, pays, takes the wallet lock or moves money. Results:
// - WRITTEN: a fact was recorded (what); NOTHING: nothing to record now (why);
// - WAIT: a source failed or the evidence is not complete yet (looked at again next tick);
// - REFUSED: a database guard (GG001) or a unique index refused the write; the caller alerts. A
//   late CONFIRMED the seqno index refuses (a live transfer holds the seqno) is kept as a `late`
//   SEQNO_HELD fact instead, so the refusal is heard once, not every hour (review F3).

export type { LateCheck, LateWritten } from './ton-late-writer';

/** An owner's Z6 hint as the step read it (AuditLog TON_TX_HINT, TonTxHintSchema). */
export interface StoredHint {
  readonly auditId: string;
  readonly txHash: string;
  readonly lt: string;
}

/** Transfers whose CONFIRMED destination was seen settled, and hints counted: kept in memory. */
const MEMORY_MAX = 4_096;

type LateAlert = 'tonLateConfirmed' | 'tonBounced' | 'needsReview' | 'tonSeqnoUnmatched';
function alert(kind: LateAlert, refId: string): TonNotice {
  return { kind: 'ALERT', alert: kind, refId };
}

@Injectable()
export class TonLateService {
  private readonly logger = new Logger(TonLateService.name);
  private readonly settled = new Set<string>();
  private readonly hintLooks = new LookCounter(MEMORY_MAX);
  private readonly writer: LateWriter;

  constructor(
    private readonly repository: TonLateRepository,
    private readonly reader: TonLateReader,
    notifier: TonNotifier,
    @Inject(TON_HOT_WALLET_ADDRESS) private readonly wallet: TonHotWalletAddress,
    @Inject(TON_TIMING) private readonly timing: TonTiming,
    @Inject(TON_PAY_ADDRESSES) private readonly payAddresses: TonPayAddresses,
  ) {
    this.writer = new LateWriter(repository, notifier, this.logger);
  }

  /** EXPIRED / CONSUMED_UNMATCHED: our message found on the chain after all (72 h watch). */
  lateConfirm(transferId: string): Promise<LateCheck> {
    return this.writer.guarded(transferId, async () => {
      const transfer = await this.ours(transferId, ['EXPIRED', 'CONSUMED_UNMATCHED']);
      if (transfer === null) return nothing('NOT_ELIGIBLE');
      if (hasLateTonFact(transfer.response)) return nothing('ALREADY');
      const look = await this.reader.findOurs(transfer);
      if (look.kind === 'STALE') return wait('SCAN_STALE');
      if (look.kind === 'PARTIAL') return wait('SCAN_PARTIAL');
      if (look.kind === 'NOT_FOUND') return nothing('NOT_FOUND');
      const step = classifyOurTx(factsOf(transfer), look.tx);
      const notices = [alert('tonLateConfirmed', transfer.id)];
      if (step.kind !== 'PAID') {
        const suspect: LateOutcome = { kind: 'LATE_SUSPECT', tx: step.tx, detail: step.detail };
        return this.writer.write(transfer.id, suspect, notices);
      }
      const result = await this.writer.write(
        transfer.id,
        { kind: 'LATE_CONFIRMED', tx: step.tx },
        notices,
      );
      if (result.kind === 'REFUSED' && result.cause === 'UNIQUE') {
        // The fact stays on the row that cannot hold it: the late scan of it ends here (F3).
        await this.writer.write(transfer.id, { kind: 'LATE_SEQNO_HELD', tx: step.tx }, []);
      }
      return result;
    });
  }

  /** CONFIRMED: the destination sent the value back, or aborted, after all (72 h watch). */
  lateBounce(transferId: string): Promise<LateCheck> {
    return this.writer.guarded(transferId, async () => {
      if (this.settled.has(transferId)) return nothing('SETTLED');
      const transfer = await this.ours(transferId, ['CONFIRMED']);
      if (transfer === null || transfer.txHash === null || transfer.txLt === null)
        return nothing('NOT_ELIGIBLE');
      const address = this.addressOf(transfer);
      const ours = await this.reader.primaryAt(address, {
        lt: transfer.txLt,
        hash: transfer.txHash,
      });
      if (ours === null) return wait('OUR_TX_NOT_LISTED');
      const paid = classifyOurTx(factsOf(transfer), ours);
      if (paid.kind !== 'PAID') return this.destinationFact(transfer.id, 'NOT_PAID', null);
      const look = await this.reader.destination(transfer.id, address, paid.out);
      const view = look.view;
      if (view.kind === 'PROCESSED') return this.settle(transfer.id, 'PROCESSED');
      if (view.kind === 'ABORTED') {
        return this.destinationFact(transfer.id, 'DESTINATION_ABORTED', look.destTxHash);
      }
      if (view.kind !== 'BOUNCED') return nothing(view.kind);
      const verdict = classifyDestination(paid, view, look.chainTime, this.timing.destGraceSec);
      if (verdict.kind === 'WAIT' || view.returnTx === null) return wait(verdict.kind);
      const outOfRange =
        verdict.kind === 'SUSPECT' &&
        (verdict.detail === 'RETURN_ABOVE_SENT' || verdict.detail === 'RETURN_BELOW_FLOOR')
          ? verdict.detail
          : null;
      if (verdict.kind !== 'BOUNCED' && outOfRange === null) return wait(verdict.kind);
      const outcome: LateOutcome = {
        kind: 'LATE_BOUNCE',
        tx: paid.tx,
        returnTx: view.returnTx,
        outOfRange,
      };
      const result = await this.writer.write(transfer.id, outcome, [
        alert('tonBounced', transfer.id),
      ]);
      if (result.kind !== 'REFUSED') this.markSettled(transfer.id);
      return result;
    });
  }

  /** A SUSPECT transfer whose transaction sent nothing, on every source: ONCHAIN_FAILED. */
  onchainFailed(transferId: string): Promise<LateCheck> {
    return this.writer.guarded(transferId, async () => {
      const transfer = await this.ours(transferId, ['SIGNED', 'BROADCAST']);
      const orderId = transfer?.orderId ?? null;
      if (transfer === null || orderId === null || transfer.orderStatus !== 'NEEDS_REVIEW') {
        return nothing('NOT_ELIGIBLE');
      }
      const recorded = failedSuspectOf(transfer.response);
      if (recorded === null) return nothing('NO_SUSPECT');
      if (this.reader.witnessCount === 0) return nothing('NO_WITNESS');
      const address = this.addressOf(transfer);
      const seen = await this.reader.atEverySource(address, recorded);
      const check = checkOnchainFailed({
        wallet: address,
        extMsgHash: transfer.extMsgHash,
        transfer: factsOf(transfer),
        recorded,
        ...seen,
      });
      if (check.kind === 'NOT_PROVEN') return nothing(check.why);
      // F5: the owner hears that TON_NOT_DEBITED can settle the order now. The refId names the
      // order and the transfer (`<orderId>_<transferId>`, read back as the order): not the plain
      // order id, which the order's own NEEDS_REVIEW alert already used.
      const outcome: LateOutcome = { kind: 'ONCHAIN_FAILED', tx: check.tx, sources: check.sources };
      return this.writer.write(transfer.id, outcome, [
        alert('needsReview', `${orderId}_${transfer.id}`),
      ]);
    });
  }

  /** The owner's Z6 hint for a CONSUMED_UNMATCHED transfer (D-64 (7), Q-7). */
  checkHint(transferId: string, hint: StoredHint): Promise<LateCheck> {
    return this.writer.guarded(transferId, async () => {
      const transfer = await this.ours(transferId, ['CONSUMED_UNMATCHED']);
      const orderId = transfer?.orderId ?? null;
      if (transfer === null || orderId === null) return nothing('NOT_ELIGIBLE');
      // F2: no witness yet is no verdict (the same hint must pass once one exists).
      if (this.reader.witnessCount === 0) return wait('NO_WITNESS');
      const address = this.addressOf(transfer);
      const ref = { lt: BigInt(hint.lt), hash: hint.txHash };
      const key = `${transfer.id}/${hint.auditId}`;
      const check = checkHint({
        wallet: address,
        transfer: factsOf(transfer),
        hint: ref,
        payAddresses: this.payAddresses,
        extMsgHash: transfer.extMsgHash,
        orderMessages: await this.repository.orderMessages(orderId, transfer.id),
        ...(await this.reader.atEverySource(address, ref)),
      });
      if (check.kind === 'REJECT') {
        if (isTransientRefusal(check.code, this.hintLooks.count(key))) return wait(check.code);
        const outcome: LateOutcome = {
          kind: 'HINT_REJECTED',
          auditId: hint.auditId,
          code: check.code,
          ...(check.otherTransferId === undefined
            ? {}
            : { other: { ...hint, transferId: check.otherTransferId } }),
        };
        // Our key signed a message none of ours (owner 2026-11-18): a NEW alert (CR m2, foreignRef).
        const foreign =
          check.code === 'FOREIGN_MESSAGE'
            ? [alert('tonSeqnoUnmatched', foreignRef(transfer.id))]
            : [];
        return this.decideHint(transfer.id, key, outcome, foreign);
      }
      const look = await this.reader.destination(key, address, check.out);
      const paid = { kind: 'PAID' as const, tx: check.tx, out: check.out };
      const verdict = hintDestination(paid, look.view, look.chainTime, this.timing.destGraceSec);
      if (verdict.kind === 'WAIT') return wait('DESTINATION');
      if (verdict.kind === 'ACCEPT') {
        const outcome: LateOutcome = { kind: 'HINT_ACCEPTED', tx: check.tx, auditId: hint.auditId };
        return this.decideHint(transfer.id, key, outcome, [alert('tonLateConfirmed', transfer.id)]);
      }
      const rejected: LateOutcome = {
        kind: 'HINT_REJECTED',
        auditId: hint.auditId,
        code: verdict.code,
      };
      return this.decideHint(
        transfer.id,
        key,
        rejected,
        verdict.bounced ? [alert('tonBounced', transfer.id)] : [],
      );
    });
  }

  /** The transfer, when it is an ORDER payout of OUR hot wallet in one of `statuses`. */
  private async ours(
    transferId: string,
    statuses: readonly TonTransferStatus[],
  ): Promise<LateTransfer | null> {
    const transfer = await this.repository.read(transferId);
    if (transfer === null || !statuses.includes(transfer.status)) return null;
    const mine =
      transfer.purpose === 'ORDER' &&
      transfer.network === this.wallet.network &&
      transfer.walletAddress === this.wallet.rawAddress;
    return mine ? transfer : null;
  }

  private addressOf(transfer: LateTransfer): Address {
    return parseTonAddress(transfer.walletAddress, 'TonTransfer.walletAddress');
  }

  private async decideHint(
    transferId: string,
    key: string,
    outcome: Extract<LateOutcome, { readonly kind: 'HINT_ACCEPTED' | 'HINT_REJECTED' }>,
    notices: readonly TonNotice[],
  ): Promise<LateCheck> {
    if (outcome.kind === 'HINT_REJECTED') {
      this.logger.warn(
        `transfer ${transferId}: hint ${outcome.auditId} rejected (${outcome.code})`,
      );
    }
    const result = await this.writer.write(transferId, outcome, notices);
    if (result.kind !== 'REFUSED') {
      this.hintLooks.forget(key);
      this.reader.forget(key);
    }
    return result;
  }

  /** F4 / owner 2026-11-18: an aborted destination or an unpaid transaction is a kept fact. */
  private async destinationFact(
    transferId: string,
    verdict: 'DESTINATION_ABORTED' | 'NOT_PAID',
    destTxHash: string | null,
  ): Promise<LateCheck> {
    this.logger.error(`transfer ${transferId}: late destination look ended ${verdict}`);
    const result = await this.writer.write(
      transferId,
      { kind: 'LATE_DESTINATION', verdict, destTxHash },
      [],
    );
    if (result.kind !== 'REFUSED') this.markSettled(transferId);
    return result;
  }

  private settle(transferId: string, why: string): LateCheck {
    this.markSettled(transferId);
    return nothing(why);
  }

  private markSettled(transferId: string): void {
    this.settled.add(transferId);
    this.reader.forget(transferId);
    for (const old of this.settled) {
      if (this.settled.size <= MEMORY_MAX) break;
      this.settled.delete(old);
    }
  }
}
