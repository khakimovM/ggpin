import { Inject, Injectable } from '@nestjs/common';
import {
  TOPUP_DEFAULTS,
  checkDailyTopupLimit,
  dailyLimitDetails,
  dailyWindowStart,
} from '@repo/shared';
import { AppError } from '../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { FixedWindowCounter } from '../../infra/redis/fixed-window-counter';
import type { IntentOwner } from './topup-intents.repository';
import { TopupIntentsRepository } from './topup-intents.repository';

export const topupRateKey = (userId: string): string => `rl:topup:${userId}`;

const MS = 1000;

function secondsUntil(at: Date, now: Date): number {
  return Math.max(1, Math.ceil((at.getTime() - now.getTime()) / MS));
}

/**
 * The anti-fraud limits of top-up requests (D-37 (7), docs/04 "Tekshiruv tartibi"). Each check
 * throws the contract's error; the caller decides the order. Redis down = the request rate
 * cannot be counted = 500, no intent (fail closed, like quotes).
 */
@Injectable()
export class TopupLimits {
  constructor(
    private readonly counter: FixedWindowCounter,
    private readonly repo: TopupIntentsRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * 5 requests per 10 minutes (every attempt counts, also a refused one) and 10 CREATED intents
   * per rolling 24 h. Both 429 RATE_LIMITED with Retry-After.
   */
  async enforceRequestRate(userId: string, now: Date): Promise<void> {
    const hit = await this.counter.hit(
      topupRateKey(userId),
      TOPUP_DEFAULTS.CREATE_LIMIT_WINDOW_SEC,
    );
    if (hit.count > TOPUP_DEFAULTS.CREATE_LIMIT_PER_WINDOW) {
      throw new AppError('RATE_LIMITED', undefined, { retryAfterSec: hit.ttlSec });
    }
    const max = TOPUP_DEFAULTS.DAILY_CREATE_LIMIT;
    const created = await this.repo.createdSince(userId, dailyWindowStart(now), max);
    if (created.count >= max && created.earliest !== null) {
      const freedAt = new Date(
        created.earliest.getTime() + TOPUP_DEFAULTS.DAILY_CREATE_WINDOW_SEC * MS,
      );
      throw new AppError('RATE_LIMITED', undefined, { retryAfterSec: secondsUntil(freedAt, now) });
    }
  }

  /** At most 3 UNPAID reserved requests; Retry-After = when the nearest one is released. */
  async enforceReservations(userId: string, now: Date): Promise<void> {
    const max = TOPUP_DEFAULTS.MAX_RESERVED_PER_USER;
    const held = await this.repo.unpaidReserved(userId, now, max);
    if (held.count >= max && held.earliest !== null) {
      throw new AppError('RATE_LIMITED', undefined, {
        retryAfterSec: secondsUntil(held.earliest, now),
      });
    }
  }

  /** Per-request range and step, then both daily caps on BASE amounts (422 either way). */
  async enforceAmount(owner: IntentOwner, baseTiyin: bigint, now: Date): Promise<void> {
    const { TOPUP_MIN_TIYIN: min, TOPUP_MAX_TIYIN: max, TOPUP_STEP_TIYIN: step } = this.config;
    if (baseTiyin < min || baseTiyin > max || baseTiyin % step !== 0n) {
      throw new AppError('TOPUP_AMOUNT_OUT_OF_RANGE', {
        min: min.toString(),
        max: max.toString(),
        step: step.toString(),
      });
    }
    const verdict = checkDailyTopupLimit({
      usedBaseTiyin: await this.repo.usedBaseSince(owner.id, dailyWindowStart(now)),
      requestedBaseTiyin: baseTiyin,
      isNewAccount: this.isNewAccount(owner, now),
      dailyMaxTiyin: this.config.TOPUP_DAILY_MAX_TIYIN,
      newAccountDailyMaxTiyin: this.config.TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN,
    });
    if (!verdict.ok) {
      throw new AppError(
        'TOPUP_AMOUNT_OUT_OF_RANGE',
        dailyLimitDetails(verdict, { minTiyin: min, stepTiyin: step }),
      );
    }
  }

  isNewAccount(owner: Pick<IntentOwner, 'createdAt'>, now: Date): boolean {
    return now.getTime() - owner.createdAt.getTime() < this.config.TOPUP_NEW_ACCOUNT_AGE_SEC * MS;
  }
}
