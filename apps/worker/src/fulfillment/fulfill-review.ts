import { Injectable, Logger } from '@nestjs/common';
import { LivePayoutError, type Prisma } from '@repo/db';
import { describeErrorForLog, type OrderStatusReason } from '@repo/shared';
import { PrismaService } from '../infra/prisma/prisma.service';
import { readPayoutState } from '../ton/ton-outcome.repository';
import { tonNoticesFor } from '../ton/ton-notices';
import { AttemptsRepository } from './attempts.repository';
import { FulfillmentNotifier } from './fulfillment-notifier';
import { reviewNotices } from './held-policy';

// Every NEEDS_REVIEW the core writes goes through here: the attempt UNKNOWN and the order
// NEEDS_REVIEW in one transaction (AttemptsRepository.toReview), then the customer's and the
// owner's notices. When the attempt signed a TON transfer, the TON module's notices for that
// transfer follow too (audit I-1): a transfer still unresolved blocks every later TON payout, and
// the owner hears `tonWalletBlocked` from the core's review just as from the TON module's.
// S9f (owner 2026-11-18): a hold or refund the database refused because an earlier payout of the
// order may be out (`LivePayoutError`: a late chain fact, a transfer only the owner may judge) is
// neither true nor retried: NEEDS_REVIEW (ADAPTER_ERROR, like an EARLIER_PAYOUT_LIVE stop), and the
// owner decides (MANUAL FAILED is the one refund past a late fact).

@Injectable()
export class FulfillReviewer {
  private readonly logger = new Logger(FulfillReviewer.name);

  constructor(
    private readonly attempts: AttemptsRepository,
    private readonly notifier: FulfillmentNotifier,
    private readonly prisma: PrismaService,
  ) {}

  /** False when the order had already left PROCESSING (someone else decided; nothing sent). */
  async review(
    orderId: string,
    attemptId: string | null,
    reason: OrderStatusReason,
    response: Prisma.InputJsonObject = {},
  ): Promise<boolean> {
    if (!(await this.attempts.toReview(orderId, attemptId, reason, response))) return false;
    this.logger.warn(`order ${orderId}: NEEDS_REVIEW (${reason})`);
    await this.notifier.send(reviewNotices(orderId));
    if (attemptId !== null) await this.tonNotices(orderId, attemptId);
    return true;
  }

  /**
   * True when `error` is a LivePayoutError: the order went to review (unless it had moved on).
   * `attemptId`: the open attempt whose hold was refused (it goes UNKNOWN with the order, CR m1).
   */
  async reviewIfPayoutLive(
    orderId: string,
    refused: string,
    error: unknown,
    attemptId: string | null = null,
  ): Promise<boolean> {
    if (!(error instanceof LivePayoutError)) return false;
    this.logger.error(`order ${orderId}: ${refused} refused, an earlier payout may have gone out`);
    await this.review(orderId, attemptId, 'ADAPTER_ERROR');
    return true;
  }

  /** Never throws: the review is committed; the next replay or the TON module repeats these. */
  private async tonNotices(orderId: string, attemptId: string): Promise<void> {
    try {
      const transferId = await this.attempts.transferIdOf(attemptId);
      if (transferId === null) return;
      await this.notifier.send(
        tonNoticesFor(await readPayoutState(this.prisma.client, transferId)),
      );
    } catch (error) {
      this.logger.error(
        `order ${orderId}: the TON notices of the review were not read: ${describeErrorForLog(error)}`,
      );
    }
  }
}
