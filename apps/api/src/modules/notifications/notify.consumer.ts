import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  notifyJobId,
  notifyJobSchema,
  ownerAlertChatIds,
  ownerAlertOutboxJobId,
  type NotifyJob,
  type TgInlineKeyboard,
} from '@repo/shared';
import { UnrecoverableError, type Job } from 'bullmq';
import { translate } from '../../common/i18n/translate';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { miniAppUrl } from '../telegram/mini-app-url';
import { NotifySourcesRepository } from './notify-sources.repository';
import { AlertSourceMissingError, OwnerAlertRenderer, moneyText } from './owner-alert.renderer';
import { TgOutboxEnqueuer } from './tg-outbox.enqueuer';

export type NotifyOutcome = 'queued' | 'skipped-blocked' | 'skipped-reversed';

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

/**
 * Consumer of `notify` (worker -> API, notify.ts in shared). The job names WHAT happened; this
 * reads the rows, renders the text in the addressee's language (HTML-escaped by `translate`)
 * and hands it to `tg-outbox`, which sends it. A top-up message's outbox job id is the notify
 * job id (`topup-<paymentId>`), so a repeated notify job queues ONE message; an owner alert's is
 * the notify id plus the recipient (`alert-<kind>-<refId>-<chatId>`, D-53): ONE message per
 * recipient.
 *
 * - TOPUP_CREDITED / TOPUP_LATE_CREDITED: the Payment row decides the user (never the job), the
 *   balance is the current SUM(ledger); nobody is written to who blocked the bot.
 * - OWNER_ALERT: Uzbek, to EVERY id of OWNER_ALERT_CHAT_ID (the partners, D-53): one outbox job
 *   per recipient with the chat id in its job id, so a retry never double-sends and a recipient
 *   who blocked the bot (403, handled by the outbox per job) never blocks the others. Without
 *   one configured the job fails (OwnerChatMissingError), it is never completed unsent.
 * Logs carry the job id and outcome, never text, amounts or chat ids.
 */
@Injectable()
export class NotifyConsumer {
  private readonly logger = new Logger('Notify');

  constructor(
    private readonly sources: NotifySourcesRepository,
    private readonly alerts: OwnerAlertRenderer,
    private readonly outbox: TgOutboxEnqueuer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async handle(job: Pick<Job, 'id' | 'data'>): Promise<NotifyOutcome> {
    const parsed = notifyJobSchema.safeParse(job.data);
    if (!parsed.success) {
      this.log(job, 'invalid-payload');
      throw new UnrecoverableError('invalid notify payload');
    }
    const data = parsed.data;
    try {
      const outcome =
        data.kind === 'OWNER_ALERT' ? await this.ownerAlert(data) : await this.topup(data);
      this.log(job, outcome);
      return outcome;
    } catch (error) {
      if (error instanceof AlertSourceMissingError || error instanceof UnrecoverableError) {
        this.log(job, 'source-missing');
        throw new UnrecoverableError('notify source missing');
      }
      throw error;
    }
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

  private async ownerAlert(
    job: Extract<NotifyJob, { kind: 'OWNER_ALERT' }>,
  ): Promise<NotifyOutcome> {
    const chatIds = ownerAlertChatIds(this.config.OWNER_ALERT_CHAT_ID);
    if (chatIds.length === 0) {
      this.logger.error('owner alert not sent: OWNER_ALERT_CHAT_ID is not configured');
      throw new OwnerChatMissingError();
    }
    const text = await this.alerts.render(job.alert, job.refId);
    // Every recipient is tried even if one enqueue fails; the job then fails and is retried, and
    // the recipients already queued are no-ops the second time (same job ids).
    const results = await Promise.allSettled(
      chatIds.map((chatId) =>
        this.outbox.enqueue(ownerAlertOutboxJobId(job, chatId), { chatId, text }),
      ),
    );
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
    return 'queued';
  }

  private log(job: Pick<Job, 'id'>, outcome: string): void {
    this.logger.log(`job=${job.id ?? '?'} outcome=${outcome}`);
  }
}
