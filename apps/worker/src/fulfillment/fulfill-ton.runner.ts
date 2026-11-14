import { Inject, Injectable, Logger } from '@nestjs/common';
import { describeErrorForLog, type OrderStatusReason } from '@repo/shared';
import { Cell } from '@ton/core';
import type { TonPayRequest, TonPayResult } from '../ton/ton-payout';
import { AttemptsRepository, type AttemptRow } from './attempts.repository';
import { RetryLaterError, tonInstructionOf } from './fulfill-steps';
import { TON_PAYER, type TonPayer } from './fulfill-tokens';
import { FulfillReviewer } from './fulfill-review';
import { FulfillmentNotifier } from './fulfillment-notifier';
import { NOT_SENT_HOLD_NOTE, TON_NOT_SENT_ERROR_PREFIX, holdNotices } from './held-policy';

/** What the core does after a step: stop, or make the next attempt (the last one was proven not sent). */
export type RunStep = 'DONE' | 'NEXT_ATTEMPT';

// The TON payout of a SENDING attempt (plan 6.4-6.6) through the TON module (S5). The attempt was
// committed SENDING with `externalRef = null`; the TON module signs, stores the transfer and the
// reference in one commit, broadcasts once, watches the chain, and writes DELIVERED / NEEDS_REVIEW /
// HELD itself with its notices. What is left here is what the core decides from the result:
// - a THROW is an unknown outcome: retried (S5: a retry only follows the attempt's transfer, never
//   signs again); on the job's last attempt the order goes to NEEDS_REVIEW, never HELD or FAILED;
// - EXPIRED (proven never sent, D-60 (2)) -> the next attempt (MAX_SEND_ATTEMPTS caps it);
// - NOT_SENT (nothing signed by this call) -> retried; on the last attempt, when the attempt still
//   has no transfer, it is FAILED and the order HELD (ADAPTER_ERROR), the owner hears;
// - STOPPED: the order or the attempt moved under us; nothing to do, or retried.

@Injectable()
export class FulfillTonRunner {
  private readonly logger = new Logger(FulfillTonRunner.name);

  constructor(
    @Inject(TON_PAYER) private readonly payer: TonPayer,
    private readonly attempts: AttemptsRepository,
    private readonly notifier: FulfillmentNotifier,
    private readonly reviewer: FulfillReviewer,
  ) {}

  async run(orderId: string, attempt: AttemptRow, final: boolean): Promise<RunStep> {
    const request = this.requestOf(orderId, attempt);
    if (request === null) {
      this.logger.error(`order ${orderId}: attempt ${attempt.id} holds no usable TON instruction`);
      return this.review(orderId, attempt.id, 'ADAPTER_ERROR');
    }
    let result: TonPayResult;
    try {
      result = await this.payer.pay(request);
    } catch (error) {
      // Unknown outcome (review m2 of S5): a retry of the same attempt is always safe.
      if (!final) throw error;
      this.logger.error(
        `order ${orderId}: TON payout unknown on the last retry: ${describeErrorForLog(error)}`,
      );
      return this.review(orderId, attempt.id, 'ADAPTER_ERROR');
    }
    this.logger.log(`order ${orderId}: TON payout ${result.status}`);
    return this.after(orderId, attempt, result, final);
  }

  private async after(
    orderId: string,
    attempt: AttemptRow,
    result: TonPayResult,
    final: boolean,
  ): Promise<RunStep> {
    switch (result.status) {
      case 'DELIVERED':
      case 'HELD':
        return 'DONE';
      case 'EXPIRED':
        return 'NEXT_ATTEMPT';
      case 'REVIEW':
        // The TON module could not record NEEDS_REVIEW (or not read the rows): ask again.
        if (result.orderStatus === null || result.orderStatus === 'PROCESSING') {
          return this.retryOr(final, 'the review was not recorded', () =>
            this.review(orderId, attempt.id, 'ADAPTER_ERROR'),
          );
        }
        return 'DONE';
      case 'NOT_SENT':
        return this.retryOr(final, `TON ${result.reason}`, () =>
          this.holdNotSent(orderId, attempt, result.reason),
        );
      case 'STOPPED':
        if (result.reason === 'ORDER_NOT_PROCESSING') return 'DONE';
        // Another call of this attempt is signing or signed: it may have gone out.
        return this.retryOr(final, `TON ${result.reason}`, () =>
          this.review(orderId, attempt.id, 'ADAPTER_ERROR'),
        );
    }
  }

  private async retryOr(
    final: boolean,
    why: string,
    onFinal: () => Promise<RunStep>,
  ): Promise<RunStep> {
    if (!final) throw new RetryLaterError(why);
    return onFinal();
  }

  private async holdNotSent(
    orderId: string,
    attempt: AttemptRow,
    reason: string,
  ): Promise<RunStep> {
    const result = await this.attempts.failAndHold(
      orderId,
      attempt.id,
      `${TON_NOT_SENT_ERROR_PREFIX}${reason}`,
      'ADAPTER_ERROR',
      NOT_SENT_HOLD_NOTE,
    );
    if (result.kind === 'HAS_TRANSFER') return this.review(orderId, attempt.id, 'ADAPTER_ERROR');
    if (result.kind === 'HELD') {
      this.logger.warn(`order ${orderId} held: the wallet stayed unusable (${reason})`);
      await this.notifier.send(holdNotices(orderId, attempt.id, 'ADAPTER_ERROR'));
    }
    return 'DONE';
  }

  private async review(
    orderId: string,
    attemptId: string,
    reason: OrderStatusReason,
  ): Promise<RunStep> {
    await this.reviewer.review(orderId, attemptId, reason);
    return 'DONE';
  }

  private requestOf(orderId: string, attempt: AttemptRow): TonPayRequest | null {
    const instruction = tonInstructionOf(attempt.request);
    if (instruction === null) return null;
    let payload: Cell;
    try {
      payload = Cell.fromBase64(instruction.payloadBoc);
    } catch {
      return null;
    }
    return {
      orderId,
      attemptId: attempt.id,
      toAddress: instruction.toAddress,
      amountNano: BigInt(instruction.amountNano),
      payload,
    };
  }
}
