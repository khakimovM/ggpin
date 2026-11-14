import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@repo/db';
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
