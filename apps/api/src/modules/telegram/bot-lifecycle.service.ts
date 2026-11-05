import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { TG_USER_CHAT_ID_PATTERN, tgOutboxJobId } from '@repo/shared';
import { translate } from '../../common/i18n/translate';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { TgOutboxEnqueuer } from '../notifications/tg-outbox.enqueuer';
import { BotSetupService } from './bot-setup.service';
import { BOT, type TelegramBot } from './bot.provider';
import { safeErrorText } from './safe-error';

/** Owner alerts of the bot lifecycle: the webhook was not set / the setup after it did not finish. */
type OwnerAlertKind = 'webhookFailed' | 'setupFailed';

export const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member'] as const;

// D-29.5: a webhook that cannot be registered must not take the API down (orders, payments and
// the web store do not depend on it), so registration is retried in the background.
export const WEBHOOK_RETRY_FIRST_DELAY_MS = 30_000;
export const WEBHOOK_RETRY_MAX_DELAY_MS = 600_000;
// The owner hears about it on the third failure (a one-off blip stays quiet), then about once
// an hour while it keeps failing (6 attempts at the 10 minute cap).
const ALERT_AFTER_FAILURES = 3;
const ALERT_REPEAT_EVERY = 6;
// Every call to Telegram made while registering is bounded: a hung request must not hold the
// background attempt (and with it every later retry) forever.
export const WEBHOOK_CALL_TIMEOUT_MS = 10_000;
export const WEBHOOK_SETUP_TIMEOUT_MS = 30_000;

/** Delay before the retry after the n-th failure (1-based): 30 s, 60 s, 120 s ... capped at 10 minutes. */
export function webhookRetryDelayMs(failures: number): number {
  const doubled = WEBHOOK_RETRY_FIRST_DELAY_MS * 2 ** Math.max(0, failures - 1);
  return Math.min(doubled, WEBHOOK_RETRY_MAX_DELAY_MS);
}

@Injectable()
export class BotLifecycleService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(BotLifecycleService.name);
  private polling = false;
  private stopped = false;
  private webhookSet = false;
  // Failed attempts since the last time the whole bot (webhook AND setup) came up. It drops to 0
  // only then, so a webhook that works while setup keeps failing still counts, backs off and alerts.
  private failures = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  // Part of the alert job id, so a restarted API alerts again: BullMQ drops an add() whose id it
  // still remembers (completed jobs are kept for a day).
  private readonly bootId = Date.now().toString(36);

  constructor(
    @Inject(BOT) private readonly bot: TelegramBot,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly setup: BotSetupService,
    private readonly outbox: TgOutboxEnqueuer,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { TELEGRAM_BOT_MODE: mode } = this.config;
    if (mode === 'off') return;

    if (mode === 'webhook') {
      const { TELEGRAM_WEBHOOK_URL: url, TELEGRAM_WEBHOOK_SECRET: secret } = this.config;
      if (url === undefined || secret === undefined) {
        throw new Error('TELEGRAM_WEBHOOK_URL and TELEGRAM_WEBHOOK_SECRET are required');
      }
      // Not awaited (D-29.5): Telegram being slow or down must not delay or stop the API. The
      // method handles its own errors; the catch is for a bug in the error handling itself.
      this.runAttempt(url, secret);
      return;
    }

    // grammY's start() deletes the webhook. With the production token that would silently switch
    // the live bot off, so a dev process must find out first and refuse.
    await this.refuseIfWebhookIsSet();
    await this.setup.run();
    this.polling = true;
    // start() resolves only when polling stops, so it must not be awaited.
    this.bot.start({ allowed_updates: [...ALLOWED_UPDATES] }).catch((error: unknown) => {
      this.polling = false;
      this.logger.error(`long polling stopped: ${safeErrorText(error)}`);
    });
  }

  // D-29.5: a failure is logged, retried with backoff and reported to the owner, but never stops
  // boot. Until the webhook is set Telegram keeps using the previous one (or none), so the bot may
  // be quiet while orders, payments and the web store keep working. Once the webhook IS set only
  // the bot setup is retried; setWebhook is not called again.
  private async attempt(url: string, secret: string): Promise<void> {
    if (this.stopped) return;
    if (!this.webhookSet) {
      try {
        await this.registerWebhook(url, secret);
        this.webhookSet = true;
      } catch (error) {
        // The message was scrubbed in registerWebhook; the original error is never logged.
        await this.failed('webhookFailed', error, url, secret);
        return;
      }
    }
    try {
      // setup.run() never throws on a Bot API error, but a hung call would block it forever.
      await this.withTimeout('bot setup', WEBHOOK_SETUP_TIMEOUT_MS, () => this.setup.run());
    } catch (error) {
      await this.failed('setupFailed', error, url, secret);
      return;
    }
    if (this.failures > 0) this.logger.log(`bot ready after ${this.failures} failed attempt(s)`);
    this.failures = 0;
  }

  private async failed(
    kind: OwnerAlertKind,
    error: unknown,
    url: string,
    secret: string,
  ): Promise<void> {
    this.failures += 1;
    const delaySec = webhookRetryDelayMs(this.failures) / 1000;
    this.logger.error(
      `${safeErrorText(error)} (attempt ${this.failures}, retrying in ${delaySec}s)`,
    );
    await this.alertOwnerIfDue(kind);
    this.scheduleRetry(url, secret);
  }

  /**
   * Rejects if `run` takes longer than `ms`. The slow request itself is not cancelled (grammY
   * types AbortSignal with its own polyfill); its late result is simply ignored.
   */
  private async withTimeout<T>(name: string, ms: number, run: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${name} timed out after ${ms / 1000}s`));
      }, ms);
    });
    try {
      return await Promise.race([run(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Fire and forget (D-29.5): an attempt handles its own errors, and the catch is for a bug in
  // that handling itself, so neither the first attempt nor a timer-driven retry can leave an
  // unhandled rejection that would take the process down.
  private runAttempt(url: string, secret: string): void {
    void this.attempt(url, secret).catch((error: unknown) => {
      this.logger.error(`bot registration crashed: ${safeErrorText(error)}`);
    });
  }

  private scheduleRetry(url: string, secret: string): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.retryTimer = null;
      this.runAttempt(url, secret);
    }, webhookRetryDelayMs(this.failures));
    // A pending retry must not keep the process alive on shutdown.
    timer.unref();
    this.retryTimer = timer;
  }

  private async alertOwnerIfDue(kind: OwnerAlertKind): Promise<void> {
    const failures = this.failures;
    if (
      failures < ALERT_AFTER_FAILURES ||
      (failures - ALERT_AFTER_FAILURES) % ALERT_REPEAT_EVERY !== 0
    ) {
      return;
    }
    const chatId = this.config.OWNER_ALERT_CHAT_ID;
    // The outbox only writes to user chats (positive ids); a group id would be rejected.
    if (chatId === undefined || !TG_USER_CHAT_ID_PATTERN.test(chatId)) {
      this.logger.warn(
        `${kind} keeps repeating but OWNER_ALERT_CHAT_ID is not a usable user chat id`,
      );
      return;
    }
    try {
      await this.outbox.enqueue(tgOutboxJobId('alert', kind, `${this.bootId}x${failures}`), {
        chatId,
        text: translate('uz', `alerts.bot.${kind}`, { attempt: failures }),
      });
    } catch (error) {
      this.logger.error(`could not queue the webhook alert: ${safeErrorText(error)}`);
    }
  }

  // handleUpdate needs botInfo; a failure here (bad token, Telegram down) is reported by the caller. grammY
  // errors carry the request (GrammyError.payload holds secret_token, HttpError.error the Bot API
  // URL with the token) and an unhandled boot rejection is printed with util.inspect, so only a
  // scrubbed one-liner leaves here, deliberately without the original error as its cause.
  private async registerWebhook(url: string, secret: string): Promise<void> {
    let failure: string | null = null;
    try {
      await this.withTimeout('bot init', WEBHOOK_CALL_TIMEOUT_MS, () => this.bot.init());
      await this.withTimeout('setWebhook', WEBHOOK_CALL_TIMEOUT_MS, () =>
        this.bot.api.setWebhook(url, {
          secret_token: secret,
          allowed_updates: [...ALLOWED_UPDATES],
        }),
      );
    } catch (error) {
      failure = safeErrorText(error);
    }
    if (failure !== null) throw new Error(`webhook setup failed: ${failure}`);
  }

  private async refuseIfWebhookIsSet(): Promise<void> {
    let url: string | null = null;
    let failure = '';
    try {
      url = (await this.bot.api.getWebhookInfo()).url ?? '';
    } catch (error) {
      failure = safeErrorText(error);
    }
    // Cannot prove there is no webhook, so do not risk taking it down.
    if (url === null)
      throw new Error(`could not check the bot's webhook before polling: ${failure}`);
    if (url !== '') {
      throw new Error(
        'TELEGRAM_BOT_MODE=polling would delete the webhook this bot token is serving (a live bot is using it). Use a separate bot token from @BotFather for development. If this IS your dev bot and the webhook is a leftover, remove it once with the Bot API method deleteWebhook.',
      );
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (!this.polling) return;
    this.polling = false;
    await this.bot.stop();
  }
}
