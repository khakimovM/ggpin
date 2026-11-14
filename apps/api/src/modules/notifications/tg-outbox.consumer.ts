import { Inject, Injectable, Logger } from '@nestjs/common';
import { TG_OUTBOX_PRIORITY, describeErrorForLog, tgOutboxJobSchema } from '@repo/shared';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { GrammyError } from 'grammy';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { RedisService } from '../../infra/redis/redis.service';
import { UsersService } from '../users/users.service';
import { maskChatId, maskChatInJobId } from './chat-id-mask';
import {
  hasOnlyOwnButtonLinks,
  outboxButtonOrigins,
  type OutboxButtonOrigins,
} from './outbox-button-origins';
import { TG_OUTBOX_SENDER, type TgOutboxSender } from './tg-outbox.sender';

const CHAT_GAP_MS = 1_000;
// A gated ordinary message comes back this much after the gate opens (plus a random share of the
// spread, so a flood does not return in one burst); a critical one comes back exactly when it
// opens. Audit M-1 (b), re-review: priority alone is lost in the delayed set, which is ordered by
// time, so the return time itself carries the priority.
const NORMAL_GATE_OFFSET_MS = 250;
const NORMAL_GATE_SPREAD_MS = 250;
// PTTL said the gate is already gone (-2): try again almost at once.
const GATE_GONE_RETRY_MS = 5;
const MIN_RETRY_AFTER_MS = 1_000;
const MAX_LOGGED_ERROR_CHARS = 200;
const BLOCKED_BY_USER = /bot was blocked by the user|user is deactivated/i;

export const chatGateKey = (chatId: string): string => `tg-outbox:chat:${chatId}`;

/**
 * Sends one outbox message. Retry policy lives here, not in the transport:
 * - per chat at most 1 message/s (Redis `SET NX PX`): a second message is delayed, not dropped,
 *   until the gate opens (its PTTL): a critical job exactly then, an ordinary one 250-500 ms later,
 *   so a critical alert that arrives during a flood is the next message to that chat;
 * - 429: delay by `retry_after` via moveToDelayed + DelayedError, which does not consume an
 *   attempt (BullMQ calls moveToDelayed with skipAttempt: true);
 * - 403 blocked/deactivated: flag the user, never retry; any other 400: never retry (deterministic);
 * - anything else (network, 5xx) is rethrown and retried with the queue backoff.
 * A job whose button opens a foreign origin (outbox-button-origins.ts) is never sent.
 *
 * Logs carry job id, attempt, outcome and a masked chat id. Never message text, markup,
 * the token, or an unscrubbed error message (grammY HttpError text may quote the API URL).
 */
@Injectable()
export class TgOutboxConsumer {
  private readonly logger = new Logger('TgOutbox');
  private readonly origins: OutboxButtonOrigins;

  constructor(
    @Inject(TG_OUTBOX_SENDER) private readonly sender: TgOutboxSender,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly redis: RedisService,
    private readonly users: UsersService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.origins = outboxButtonOrigins(config);
  }

  async handle(job: Job, token: string | undefined): Promise<void> {
    const parsed = tgOutboxJobSchema.safeParse(job.data);
    if (!parsed.success) {
      this.log(job, 'invalid-payload');
      throw new UnrecoverableError('invalid tg-outbox payload');
    }
    const data = parsed.data;
    if (!hasOnlyOwnButtonLinks(data, this.origins)) {
      this.log(job, 'foreign-button-origin');
      throw new UnrecoverableError('invalid tg-outbox payload');
    }
    if (token === undefined) throw new Error('worker token missing');

    const gate = await this.redis.client.set(
      chatGateKey(data.chatId),
      '1',
      'PX',
      CHAT_GAP_MS,
      'NX',
    );
    if (gate === null) {
      this.log(job, 'chat-throttled', data.chatId);
      const gateTtl = await this.redis.client.pttl(chatGateKey(data.chatId));
      await this.delay(job, token, gateDelayMs(gateTtl, job.opts.priority));
    }

    try {
      await this.sender.send(data);
    } catch (error) {
      await this.mapError(error, job, token, data.chatId);
    }
    this.log(job, 'sent', data.chatId);
  }

  private async mapError(error: unknown, job: Job, token: string, chatId: string): Promise<void> {
    if (error instanceof GrammyError) {
      if (error.error_code === 429) {
        this.log(job, 'rate-limited', chatId);
        const retryAfter = error.parameters.retry_after ?? 1;
        await this.delay(job, token, Math.max(retryAfter * 1_000, MIN_RETRY_AFTER_MS));
      }
      if (error.error_code === 403) {
        if (BLOCKED_BY_USER.test(error.description)) {
          await this.users.markBotBlocked(BigInt(chatId), this.clock.now());
          this.log(job, 'blocked-by-user', chatId);
        } else {
          this.log(job, 'forbidden', chatId);
        }
        throw new UnrecoverableError('telegram 403');
      }
      if (error.error_code === 400) {
        // Deterministic (chat not found, can't parse entities, message too long): a retry
        // cannot succeed. The description is Telegram's text and never quotes the message.
        this.log(job, 'bad-request', chatId, error);
        throw new UnrecoverableError('telegram 400');
      }
    }
    this.log(job, 'retry', chatId, error);
    throw error;
  }

  /** Reschedules the job without consuming an attempt and stops this run. */
  private async delay(job: Job, token: string, ms: number): Promise<never> {
    await job.moveToDelayed(Date.now() + ms, token);
    throw new DelayedError();
  }

  private log(job: Job, outcome: string, chatId?: string, error?: unknown): void {
    const parts = [
      // The id of an owner-alert job ends with the chat id: masked like the `chat=` part (D-53).
      `job=${job.id === undefined ? '?' : maskChatInJobId(job.id, chatId)}`,
      `attempt=${job.attemptsMade + 1}`,
      `outcome=${outcome}`,
      ...(chatId === undefined ? [] : [`chat=${maskChatId(chatId)}`]),
      ...(error === undefined ? [] : [`error=${describeError(error)}`]),
    ];
    this.logger.log(parts.join(' '));
  }
}

/**
 * How long a gated job waits (ms), from the gate's remaining PTTL: a critical job until the gate
 * opens, any other one 250-500 ms after that. -2 (the gate just expired): retry at once; -1 (no
 * expiry, never written that way): a full gap.
 */
export function gateDelayMs(
  gateTtl: number,
  priority: number | undefined,
  random: () => number = Math.random,
): number {
  const opensIn = gateTtl === -2 ? GATE_GONE_RETRY_MS : gateTtl < 0 ? CHAT_GAP_MS : gateTtl;
  if (priority === TG_OUTBOX_PRIORITY.critical) return Math.max(opensIn, 1);
  return opensIn + NORMAL_GATE_OFFSET_MS + Math.floor(random() * NORMAL_GATE_SPREAD_MS);
}

// A database error (a user lookup that failed) is described from names only (review M1).
function describeError(error: unknown): string {
  return describeErrorForLog(error, MAX_LOGGED_ERROR_CHARS);
}
