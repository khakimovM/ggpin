import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BankFeedAlertKindSchema,
  FulfillmentAlertKindSchema,
  describeErrorForLog,
  notifyJobId,
  notifyJobSchema,
  ownerAlertChatIds,
  ownerAlertOutboxJobId,
  ownerAlertPriority,
  type NotifyJob,
  type TgInlineKeyboard,
} from '@repo/shared';
import { UnrecoverableError, type Job } from 'bullmq';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { TranslationError, translate } from '../../common/i18n/translate';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { miniAppUrl } from '../telegram/mini-app-url';
import { FulfillmentAlertRenderer } from './fulfillment-alert.renderer';
import { NotifySourcesRepository } from './notify-sources.repository';
import { OrderNotifyRenderer, OrderSourceMissingError } from './order-notify.renderer';
import { ownerAlertFallbackText } from './owner-alert.fallback';
import { AlertSourceMissingError, OwnerAlertRenderer, moneyText } from './owner-alert.renderer';
import { TgOutboxEnqueuer } from './tg-outbox.enqueuer';

export type NotifyOutcome = 'queued' | 'skipped-blocked' | 'skipped-reversed' | 'skipped-stale';

/**
 * No OWNER_ALERT_CHAT_ID configured (dev/test only; production refuses to boot without it). The
 * alert job FAILS and stays in the failed set (retried, then kept 7 days) instead of completing
 * silently: an owner alert is never dropped as "done".
 */
export class OwnerChatMissingError extends Error {
  constructor() {
    super('OWNER_ALERT_CHAT_ID is not configured');
    this.name = 'OwnerChatMissingError';
  }
}

type TopupJob = Extract<NotifyJob, { kind: 'TOPUP_CREDITED' | 'TOPUP_LATE_CREDITED' }>;
type OrderJob = Extract<NotifyJob, { kind: `ORDER_${string}` }>;
type OwnerAlertJob = Extract<NotifyJob, { kind: 'OWNER_ALERT' }>;
/** What the consumer reads of a BullMQ job; the attempt fields decide the last-attempt fallback. */
export type NotifyJobLike = Pick<Job, 'id' | 'data'> & Partial<Pick<Job, 'attemptsMade' | 'opts'>>;

const MAX_LOGGED_ERROR_CHARS = 200;

/**
 * Consumer of `notify` (worker -> API, notify.ts in shared). The job names WHAT happened; this
 * reads the rows, renders the text in the addressee's language (HTML-escaped by `translate`)
 * and hands it to `tg-outbox`, which sends it. A customer message's outbox job id is the notify
 * job id (`topup-<paymentId>`, `order-<orderId>-<event>`), so a repeated notify job queues ONE
 * message; an owner alert's is the notify id plus the recipient (`alert-<kind>-<refId>-<chatId>`,
 * D-53): ONE message per recipient.
 *
 * - TOPUP_CREDITED / TOPUP_LATE_CREDITED: the Payment row decides the user (never the job), the
 *   balance is the current SUM(ledger); nobody is written to who blocked the bot.
 * - ORDER_*: OrderNotifyRenderer (the Order row decides the user; blocked, or no longer true:
 *   skipped).
 * - OWNER_ALERT: Uzbek (bank-feed alerts: OwnerAlertRenderer, fulfillment alerts:
 *   FulfillmentAlertRenderer), to EVERY id of OWNER_ALERT_CHAT_ID (the partners, D-53): one
 *   outbox job per recipient with the chat id in its job id, so a retry never double-sends and a
 *   recipient who blocked the bot (403, handled by the outbox per job) never blocks the others.
 *   Without one configured the job fails (OwnerChatMissingError), it is never completed unsent.
 *   A critical alert (CRITICAL_OWNER_ALERTS) goes on the outbox with the critical priority, ahead
 *   of a flood of ordinary ones (audit M-1 (b)). If its rows cannot be read (database down) on
 *   the job's LAST attempt, it is sent with what its refId says and `?` in the other gaps instead
 *   of being lost (audit L-3).
 * Logs carry the job id, the outcome and a redacted error, never text, amounts or chat ids.
 */
@Injectable()
export class NotifyConsumer {
  private readonly logger = new Logger('Notify');

  constructor(
    private readonly sources: NotifySourcesRepository,
    private readonly alerts: OwnerAlertRenderer,
    private readonly outbox: TgOutboxEnqueuer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly orders: OrderNotifyRenderer,
    private readonly fulfillment: FulfillmentAlertRenderer,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async handle(job: NotifyJobLike): Promise<NotifyOutcome> {
    const parsed = notifyJobSchema.safeParse(job.data);
    if (!parsed.success) {
      this.log(job, 'invalid-payload');
      throw new UnrecoverableError('invalid notify payload');
    }
    try {
      const outcome = await this.route(parsed.data, job);
      this.log(job, outcome);
      return outcome;
    } catch (error) {
      if (
        error instanceof AlertSourceMissingError ||
        error instanceof OrderSourceMissingError ||
        error instanceof UnrecoverableError
      ) {
        this.log(job, 'source-missing');
        throw new UnrecoverableError('notify source missing');
      }
      // Already logged where it was thrown (review m5).
      if (error instanceof OwnerChatMissingError) throw error;
      // Retried by BullMQ. A database error is described from names only (describeErrorForLog).
      const reason = describeErrorForLog(error, MAX_LOGGED_ERROR_CHARS);
      this.logger.warn(`job=${job.id ?? '?'} outcome=error error=${reason}`);
      throw error;
    }
  }

  private route(data: NotifyJob, job: NotifyJobLike): Promise<NotifyOutcome> {
    switch (data.kind) {
      case 'OWNER_ALERT':
        return this.ownerAlert(data, job);
      case 'TOPUP_CREDITED':
      case 'TOPUP_LATE_CREDITED':
        return this.topup(data);
      case 'ORDER_ACCEPTED':
      case 'ORDER_DELIVERED':
      case 'ORDER_REVIEW':
      case 'ORDER_REFUNDED':
        return this.order(data);
    }
  }

  private async order(job: OrderJob): Promise<NotifyOutcome> {
    const result = await this.orders.render(job.kind, job.refId);
    if (result.kind !== 'message') return result.kind;
    await this.outbox.enqueue(notifyJobId(job), result.job);
    return 'queued';
  }

  private async topup(job: TopupJob): Promise<NotifyOutcome> {
    const payment = await this.sources.payment(job.refId);
    if (payment === null) throw new UnrecoverableError('payment missing');
    // Reversed before we got here: "your wallet was topped up" would now be false.
    if (payment.status !== 'CONFIRMED') return 'skipped-reversed';
    const user = payment.user;
    if (user.botBlockedAt !== null) return 'skipped-blocked';
    const balance = await this.sources.balance(payment.userId);
    const key =
      job.kind === 'TOPUP_LATE_CREDITED'
        ? 'bot.wallet.topupLateCredited'
        : 'bot.wallet.topupCredited';
    const text = translate(user.locale, key, {
      amount: moneyText(payment.amountTiyin, user.locale),
      balance: moneyText(balance, user.locale),
    });
    // Button to the Mini App top-up page; without MINI_APP_URL (dev) the message goes out bare.
    const url = miniAppUrl(this.config, '/topup');
    const replyMarkup: TgInlineKeyboard | undefined =
      url === undefined
        ? undefined
        : {
            inline_keyboard: [
              [{ text: translate(user.locale, 'bot.wallet.topupButton'), web_app: { url } }],
            ],
          };
    await this.outbox.enqueue(notifyJobId(job), {
      chatId: user.telegramId.toString(),
      text,
      ...(replyMarkup === undefined ? {} : { replyMarkup }),
    });
    return 'queued';
  }

  private async ownerAlert(job: OwnerAlertJob, raw: NotifyJobLike): Promise<NotifyOutcome> {
    const chatIds = ownerAlertChatIds(this.config.OWNER_ALERT_CHAT_ID);
    if (chatIds.length === 0) {
      this.logger.error('owner alert not sent: OWNER_ALERT_CHAT_ID is not configured');
      throw new OwnerChatMissingError();
    }
    const text = await this.ownerAlertText(job, raw);
    const priority = ownerAlertPriority(job.alert);
    // Every recipient is tried even if one enqueue fails; the job then fails and is retried, and
    // the recipients already queued are no-ops the second time (same job ids).
    const results = await Promise.allSettled(
      chatIds.map((chatId) =>
        this.outbox.enqueue(ownerAlertOutboxJobId(job, chatId), { chatId, text }, priority),
      ),
    );
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
    return 'queued';
  }

  private async ownerAlertText(job: OwnerAlertJob, raw: NotifyJobLike): Promise<string> {
    try {
      // OwnerAlertKind is the union of the two lists (notify.ts); the schema already checked it.
      const bankAlert = BankFeedAlertKindSchema.safeParse(job.alert);
      return bankAlert.success
        ? await this.alerts.render(bankAlert.data, job.refId)
        : await this.fulfillment.render(FulfillmentAlertKindSchema.parse(job.alert), job.refId);
    } catch (error) {
      // A missing row (deliberately unsent) or a broken template is not a read failure; earlier
      // attempts are retried as before.
      const deliberate =
        error instanceof AlertSourceMissingError ||
        error instanceof UnrecoverableError ||
        error instanceof TranslationError;
      if (deliberate || !isLastAttempt(raw)) throw error;
      const reason = describeErrorForLog(error, MAX_LOGGED_ERROR_CHARS);
      this.logger.warn(`job=${raw.id ?? '?'} outcome=render-fallback error=${reason}`);
      return ownerAlertFallbackText(job.alert, job.refId, this.clock.now());
    }
  }

  private log(job: Pick<Job, 'id'>, outcome: string): void {
    this.logger.log(`job=${job.id ?? '?'} outcome=${outcome}`);
  }
}

/**
 * True on a job's last attempt: BullMQ counts the attempts already made (`attemptsMade`, 0 on the
 * first run) against `opts.attempts`. A job without these fields (a direct call) is never last.
 */
function isLastAttempt(job: NotifyJobLike): boolean {
  if (job.opts === undefined || job.attemptsMade === undefined) return false;
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}
