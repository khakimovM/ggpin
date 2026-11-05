import { timingSafeEqual } from 'node:crypto';
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Res,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { z } from 'zod';
import { Public } from '../../common/auth/public.decorator';
import { SkipCsrf } from '../../common/auth/skip-csrf.decorator';
import { AppError } from '../../common/exceptions/app-error';
import { RawResponse } from '../../common/http/raw-response.decorator';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { BOT, type TelegramBot } from './bot.provider';
import { safeErrorText } from './safe-error';

// Only the envelope is checked; grammY and Telegram own the rest of the shape. Body size is
// capped by the global Fastify bodyLimit.
const UpdateEnvelope = z.looseObject({ update_id: z.number().int().nonnegative() });

// Only the part of the Fastify reply this controller uses (see health.controller.ts).
interface StatusReply {
  status(statusCode: number): unknown;
}

function secretMatches(received: string | string[] | undefined, expected: string): boolean {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on unequal lengths, so compare lengths first.
  return a.length === b.length && timingSafeEqual(a, b);
}

// Authenticated by the secret header, not by a session; Telegram's IPs must never see 429.
@Public()
@SkipCsrf()
@RawResponse()
@SkipThrottle()
@Controller('telegram')
export class TelegramWebhookController {
  private readonly logger = new Logger(TelegramWebhookController.name);

  constructor(
    @Inject(BOT) private readonly bot: TelegramBot,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  async receive(
    @Headers('x-telegram-bot-api-secret-token') secret: string | string[] | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: StatusReply,
  ): Promise<{ ok: boolean }> {
    const expected = this.config.TELEGRAM_WEBHOOK_SECRET;
    // 404, not 401/403: do not confirm to a scanner that this endpoint exists.
    if (this.config.TELEGRAM_BOT_MODE !== 'webhook' || expected === undefined) {
      throw new AppError('NOT_FOUND');
    }
    if (!secretMatches(secret, expected)) throw new AppError('NOT_FOUND');

    const parsed = UpdateEnvelope.safeParse(body);
    if (!parsed.success) throw new AppError('VALIDATION_ERROR');

    // D-29.5: boot no longer waits for Telegram, so an update can arrive before the bot has
    // fetched its own info. handleUpdate would throw, the catch below would answer 200 and
    // Telegram would drop the update for good; 503 makes Telegram retry it.
    if (!this.bot.isInited()) {
      this.logger.warn(`update ${parsed.data.update_id} refused: the bot is not initialised yet`);
      reply.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { ok: false };
    }

    try {
      // Update is Telegram's own schema; the envelope check above is all we verify.
      await this.bot.handleUpdate(parsed.data);
    } catch (error) {
      // Never answer non-2xx for a handler failure: Telegram would retry the same update and
      // hold back the chat's later ones. Log without the update body (user text).
      this.logger.error(`update ${parsed.data.update_id} failed: ${safeErrorText(error)}`);
    }
    return { ok: true };
  }
}
