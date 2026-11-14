import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { NeedsReviewProofSchema, describeErrorForLog, type OrderStatusReason } from '@repo/shared';
import type {
  ConfirmResult,
  FulfillmentAdapter,
  PrepareContext,
  PreparedFulfillment,
  SendResult,
} from '../adapters/fulfillment-adapter';
import { toAttemptJson } from './attempt-json';
import { AttemptsRepository, type AttemptRow } from './attempts.repository';
import { FulfillReviewer } from './fulfill-review';
import { supplierNotSentProven } from './fulfill-steps';
import type { RunStep } from './fulfill-ton.runner';
import { FULFILL_TIMING, type FulfillTiming } from './fulfill-tokens';
import { FulfillmentNotifier } from './fulfillment-notifier';
import { deliveredNotice } from './held-policy';

// The payout of a SENDING attempt through a supplier adapter (send -> confirm; rules/45 steps 6-7).
// After the SENDING commit nothing here throws for "unknown": every outcome is a result.
// - fresh attempt: `send` once. SENT -> watch with `confirm`; UNKNOWN or a throw -> NEEDS_REVIEW;
//   NOT_SENT -> NEEDS_REVIEW unless its proof is one the core may act on alone
//   (supplierNotSentProven: none exists before S8), only then FAILED and the next attempt.
// - the supplier's idempotency key is the order id (CLAUDE.md §5.4), never the attempt number.
// - resumed attempt (a crash left it SENDING / SENT): never sent again. Only `confirm` with the
//   reference committed with SENDING; whatever is not a clear DELIVERED goes to NEEDS_REVIEW.
// - the watch ends at TON_CONFIRM_TIMEOUT_MS after the attempt was committed (database clock):
//   NEEDS_REVIEW (CONFIRM_TIMEOUT).

@Injectable()
export class FulfillSupplierRunner {
  private readonly logger = new Logger(FulfillSupplierRunner.name);

  constructor(
    private readonly attempts: AttemptsRepository,
    private readonly notifier: FulfillmentNotifier,
    private readonly reviewer: FulfillReviewer,
    @Inject(FULFILL_TIMING) private readonly timing: FulfillTiming,
  ) {}

  async run(
    context: PrepareContext,
    attempt: AttemptRow,
    adapter: FulfillmentAdapter | null,
    prepared: PreparedFulfillment | null,
  ): Promise<RunStep> {
    const orderId = context.orderId;
    if (adapter === null || attempt.externalRef === null) {
      this.logger.error(`order ${orderId}: attempt ${attempt.id} cannot be followed here`);
      return this.review(orderId, attempt.id, 'ADAPTER_ERROR', { followable: false });
    }
    // A resumed attempt may have been sent before the crash: only looked up, never sent again.
    if (prepared === null) return this.watch(context, attempt, adapter, attempt.externalRef);
    let sent: SendResult;
    try {
      sent = await adapter.send(context, prepared);
    } catch (error) {
      this.logger.error(`order ${orderId}: supplier send threw: ${describeErrorForLog(error)}`);
      return this.review(orderId, attempt.id, 'ADAPTER_ERROR', { send: 'THREW' });
    }
    switch (sent.status) {
      case 'UNKNOWN':
        return this.review(orderId, attempt.id, 'ADAPTER_ERROR', { send: 'UNKNOWN' });
      case 'NOT_SENT':
        return this.notSent(orderId, attempt, sent.proof);
      case 'SENT':
        if (sent.externalRef !== attempt.externalRef) {
          return this.review(orderId, attempt.id, 'ADAPTER_ERROR', { send: 'REF_MISMATCH' });
        }
        await this.attempts.markSent(attempt.id, {
          send: 'SENT',
          ...(sent.response === undefined ? {} : { sendResponse: toAttemptJson(sent.response) }),
        });
        return this.watch(context, attempt, adapter, attempt.externalRef);
    }
  }

  private async notSent(orderId: string, attempt: AttemptRow, proof: unknown): Promise<RunStep> {
    const parsed = NeedsReviewProofSchema.safeParse(proof);
    if (!parsed.success || !supplierNotSentProven(parsed.data)) {
      // A MANUAL or TON proof from an adapter is a claim the core may not act on (CR M2).
      const kind = parsed.success ? parsed.data.kind : 'INVALID';
      return this.review(orderId, attempt.id, 'ADAPTER_ERROR', {
        send: 'NOT_SENT_UNPROVEN',
        proofKind: kind,
      });
    }
    const failed = await this.attempts.failProven(orderId, attempt.id, 'NOT_SENT', {
      send: 'NOT_SENT',
      notSentProof: toAttemptJson(parsed.data),
    });
    if (!failed) return 'DONE';
    this.logger.warn(`order ${orderId}: attempt ${attempt.id} proven not sent`);
    return 'NEXT_ATTEMPT';
  }

  private async watch(
    context: PrepareContext,
    attempt: AttemptRow,
    adapter: FulfillmentAdapter,
    externalRef: string,
  ): Promise<RunStep> {
    const orderId = context.orderId;
    for (;;) {
      let result: ConfirmResult | null = null;
      try {
        result = await adapter.confirm(context, externalRef);
      } catch (error) {
        this.logger.warn(
          `order ${orderId}: supplier status unknown: ${describeErrorForLog(error)}`,
        );
      }
      if (result?.status === 'DELIVERED') return this.deliver(orderId, attempt.id);
      if (result !== null && result.status !== 'PENDING') {
        // NOT_SENT after a send is the provider's word, not ours to act on: the reconciler or an
        // operator decides with the proof (fulfillment-adapter.ts). Conservative in phase 5.
        return this.review(orderId, attempt.id, 'ADAPTER_ERROR', { confirm: result.status });
      }
      if ((await this.attempts.ageMs(attempt.id)) >= this.timing.confirmTimeoutMs) {
        return this.review(orderId, attempt.id, 'CONFIRM_TIMEOUT', { confirm: 'TIMEOUT' });
      }
      await sleep(this.timing.pollMs);
    }
  }

  private async deliver(orderId: string, attemptId: string): Promise<RunStep> {
    if (await this.attempts.deliver(orderId, attemptId, { confirm: 'DELIVERED' })) {
      this.logger.log(`order ${orderId}: DELIVERED`);
      await this.notifier.send([deliveredNotice(orderId)]);
    }
    return 'DONE';
  }

  private async review(
    orderId: string,
    attemptId: string,
    reason: OrderStatusReason,
    facts: Record<string, string | boolean>,
  ): Promise<RunStep> {
    await this.reviewer.review(orderId, attemptId, reason, { supplier: facts });
    return 'DONE';
  }
}
