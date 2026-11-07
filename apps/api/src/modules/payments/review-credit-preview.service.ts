import { Inject, Injectable } from '@nestjs/common';
import { checkedId } from '../../common/admin/admin-input';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppError } from '../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import type { Db } from '../../infra/prisma/db';
import { CardPoolRepository } from './card-pool.repository';
import {
  creditWindowStart,
  creditableAmount,
  needsBankVerification,
  overrideNeeded,
  userCheck,
  type CreditTarget,
  type UserCheck,
} from './review-credit.checks';
import { ReviewChecksRepository } from './review-checks.repository';
import { ReviewRepository, type IntentForCredit } from './review.repository';

/** What review:credit shows before it asks for anything (unlocked; checked again in the credit). */
export interface CreditPreview {
  readonly amountTiyin: bigint;
  readonly userId: string;
  readonly needsBankVerification: boolean;
  readonly user: UserCheck;
  readonly overrideNeeded: string | null;
}

/**
 * The reads review:credit decides on (docs/05 §7, D-46): the amount, who gets it and the user's
 * state (blocked, frozen, age, today's base sum against the cap). `preview` is unlocked, for the
 * CLI and for the flags the owner's code is checked against; ReviewCreditService calls
 * `userCheck` again under the wallet lock.
 */
@Injectable()
export class ReviewCreditPreviewService {
  constructor(
    private readonly repo: ReviewRepository,
    private readonly checks: ReviewChecksRepository,
    private readonly pool: CardPoolRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async preview(rawReviewId: string, rawTarget: CreditTarget): Promise<CreditPreview> {
    const reviewId = checkedId('reviewId', rawReviewId);
    const target = checkedTarget(rawTarget);
    const review = await this.repo.find(reviewId);
    if (review === null) throw new AppError('NOT_FOUND');
    const amountTiyin = creditableAmount(review);
    const intent = 'intentId' in target ? await this.repo.findIntent(target.intentId) : null;
    if ('intentId' in target && intent === null) throw new AppError('NOT_FOUND');
    const userId = intent?.userId ?? ('userId' in target ? target.userId : '');
    const user = await this.userCheck(this.pool.client, userId, intent, amountTiyin);
    return {
      amountTiyin,
      userId,
      needsBankVerification: needsBankVerification(review),
      user,
      overrideNeeded: overrideNeeded(user),
    };
  }

  // The request's own base when crediting a request (as the matcher), the whole amount otherwise.
  async userCheck(
    db: Db,
    userId: string,
    intent: IntentForCredit | null,
    amount: bigint,
  ): Promise<UserCheck> {
    const now = this.clock.now();
    const state = await this.checks.userState(db, userId, creditWindowStart(now), intent?.id);
    if (state === null) throw new AppError('NOT_FOUND');
    return userCheck(state, intent?.baseAmountTiyin ?? amount, now, this.config);
  }
}

export function checkedTarget(target: CreditTarget): CreditTarget {
  return 'userId' in target
    ? { userId: checkedId('userId', target.userId) }
    : { intentId: checkedId('intentId', target.intentId) };
}
