import { Inject, Injectable } from '@nestjs/common';
import {
  FULFILLMENT_ALERT_PARAMS,
  HELD_REASON_LABEL_KEYS,
  QUEUE_STUCK_AFTER_MS,
  formatMajor,
  parseWorkerDownRef,
  refIdSubject,
  shortTonAddress,
  type FulfillmentAlertKind,
} from '@repo/shared';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { translate, type TranslateParams } from '../../common/i18n/translate';
import { NotifySourcesRepository } from './notify-sources.repository';
import { orderProductText } from './order-notify.renderer';
import { moneyText } from './owner-alert.renderer';

type Params = Record<string, string | number>;

const OWNER_LOCALE = 'uz' as const;
/** Printed for a value that cannot be read: an owner alert is never dropped for a missing row. */
const UNKNOWN = '?';

/**
 * Fulfillment owner alerts (`notify` OWNER_ALERT with a FulfillmentAlertKind, docs/06 "Limitlar va
 * ogohlantirishlar"): Uzbek, sent by the consumer to every partner (D-53). Parameters are read by
 * `refId` and limited to FULFILLMENT_ALERT_PARAMS: the order #, ids, codes, amounts and a
 * SHORTENED wallet address; never a cookie, mnemonic, key, hash or full address (S6 rule).
 *
 * Unlike the bank-feed alerts, a row that cannot be read does not drop the alert: these say money
 * may have left the wallet or fulfillment stopped, so the owner hears it with `?` in the gaps and
 * the raw refId (our own id, from the worker) to look it up.
 *
 * refIds (worker ton-notices, docs/06 "S6 uchun"): needsReview / reviewResolved /
 * heldExpiredRefunded = orderId; held / tonDailyLimit = `<orderId>_<attemptId>`; tonLowBalance =
 * the WalletSnapshot; ton* transfer alerts = the TonTransfer; workerDown = the outage start;
 * queueStuck = `<jobId>_<added ms>` (the job id is the order id, alertRef.queueStuck).
 */
@Injectable()
export class FulfillmentAlertRenderer {
  constructor(
    private readonly sources: NotifySourcesRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async render(alert: FulfillmentAlertKind, refId: string): Promise<string> {
    const params = await this.params(alert, refId);
    // Exactly the declared placeholders (a test holds both catalogs to the same list).
    const declared: TranslateParams = Object.fromEntries(
      FULFILLMENT_ALERT_PARAMS[alert].map((name) => [name, params[name] ?? UNKNOWN]),
    );
    return translate(OWNER_LOCALE, `alerts.fulfillment.${alert}`, declared);
  }

  private async params(alert: FulfillmentAlertKind, refId: string): Promise<Params> {
    switch (alert) {
      case 'needsReview':
      case 'held':
      case 'reviewResolved':
      case 'tonDailyLimit':
        return this.orderParams(refId);
      case 'heldExpiredRefunded':
        return this.orderParams(refId, { withRefund: true });
      case 'queueStuck': {
        const params = await this.orderParams(refId);
        return { ...params, minutes: QUEUE_STUCK_AFTER_MS / 60_000 };
      }
      case 'tonSeqnoUnmatched':
      case 'tonConsumedUnmatched':
      case 'tonBounced':
      case 'tonWalletBlocked':
      case 'tonWalletCompromised':
      case 'tonWitnessConflict':
        return this.transferParams(refId);
      case 'tonLowBalance': {
        const snapshot = await this.sources.walletSnapshot(refId);
        if (snapshot === null) return {};
        return { balance: tonText(snapshot.nanoTon), address: shortTonAddress(snapshot.address) };
      }
      case 'workerDown': {
        const since = parseWorkerDownRef(refId);
        if (since === null) return {};
        const minutes = Math.floor((this.clock.now().getTime() - since.getTime()) / 60_000);
        return { minutes: Math.max(0, minutes) };
      }
      case 'fragmentSessionDead':
      case 'fragmentSessionRestored':
      case 'fragmentAdapterDown':
        return {};
    }
  }

  /**
   * `<orderId>` or `<orderId>_<suffix>`: the order's #, product, reason and status; with
   * `withRefund` also the amount of its REFUND entry (S6 review m3: what reached the wallet, never
   * recomputed from the price; none found: `?`).
   */
  private async orderParams(
    refId: string,
    { withRefund = false }: { readonly withRefund?: boolean } = {},
  ): Promise<Params> {
    const orderId = refIdSubject(refId) ?? refId;
    const params: Params = { ref: orderId };
    const order = await this.sources.order(orderId);
    if (order === null) return params;
    params['number'] = String(order.number);
    params['product'] = orderProductText(order, OWNER_LOCALE);
    params['status'] = order.status;
    params['reason'] = reasonText(order.statusReason);
    if (withRefund) {
      const refund = await this.sources.orderRefund(order.id);
      if (refund !== null) params['amount'] = moneyText(refund.amountTiyin, OWNER_LOCALE);
    }
    return params;
  }

  private async transferParams(transferId: string): Promise<Params> {
    const params: Params = { ref: transferId };
    const transfer = await this.sources.tonTransfer(transferId);
    if (transfer === null) return params;
    params['seqno'] = transfer.seqno;
    params['amount'] = tonText(transfer.amountNanoTon);
    params['to'] = shortTonAddress(transfer.toAddress);
    const order = transfer.attempt?.order;
    if (order !== undefined) params['number'] = String(order.number);
    return params;
  }
}

function tonText(nanoTon: bigint): string {
  return translate(OWNER_LOCALE, 'common.money.ton', { amount: formatMajor('TON', nanoTon) });
}

/** A HELD reason as a label; another code as itself (our closed enum); none as `-`. */
function reasonText(reason: string | null): string {
  if (reason === null) return '-';
  const key = Object.entries(HELD_REASON_LABEL_KEYS).find(([code]) => code === reason)?.[1];
  return key === undefined
    ? reason
    : translate(OWNER_LOCALE, `alerts.fulfillment.heldReason.${key}`);
}
