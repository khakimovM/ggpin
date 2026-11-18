import type { Logger } from '@nestjs/common';
import { isUniqueViolation } from '../bank-feed/prisma-errors';
import { errorKind, isGuardRefusal } from './ton-db-errors';
import { TonGatewayError } from './ton-gateway';
import type { TonLateRepository } from './ton-late.repository';
import type { LateOutcome } from './ton-late-writes';
import type { TonNotice } from './ton-notices';
import type { TonNotifier } from './ton-notifier';

// What one late look of TonLateService returns, and the write every look ends with (phase 5 S9f):
// the repository's one transaction, then the notices AFTER the commit (stable ids). A guard
// refusal (GG001) or a unique index (P2002) is REFUSED for the caller's alert, never retried here;
// a late CONFIRMED the unique index refused still sends its own alert (the chain fact stands even
// when the row cannot record it). A failed chain read is a WAIT, never an answer.

export type LateWritten = LateOutcome['kind'];

export type LateCheck =
  | { readonly kind: 'WRITTEN'; readonly what: LateWritten }
  | { readonly kind: 'NOTHING'; readonly why: string }
  | { readonly kind: 'WAIT'; readonly why: string }
  | { readonly kind: 'REFUSED'; readonly orderId: string | null; readonly cause: string };

export const nothing = (why: string): LateCheck => ({ kind: 'NOTHING', why });
export const wait = (why: string): LateCheck => ({ kind: 'WAIT', why });

export class LateWriter {
  constructor(
    private readonly repository: TonLateRepository,
    private readonly notifier: TonNotifier,
    private readonly logger: Logger,
  ) {}

  async write(
    transferId: string,
    outcome: LateOutcome,
    notices: readonly TonNotice[],
  ): Promise<LateCheck> {
    let applied;
    try {
      applied = await this.repository.apply(transferId, outcome);
    } catch (error) {
      if (!isGuardRefusal(error) && !isUniqueViolation(error)) throw error;
      this.logger.error(
        `transfer ${transferId}: ${outcome.kind} refused by the database (${errorKind(error)})`,
      );
      if (outcome.kind === 'LATE_CONFIRMED') await this.notifier.send(notices);
      const cause = isGuardRefusal(error) ? 'GG001' : 'UNIQUE';
      return { kind: 'REFUSED', orderId: await this.repository.orderOf(transferId), cause };
    }
    if (!applied.written) return nothing('ALREADY');
    this.logger.log(`transfer ${transferId}: ${outcome.kind} recorded`);
    const review: TonNotice[] =
      applied.reviewed && applied.orderId !== null
        ? [
            { kind: 'ORDER_REVIEW', orderId: applied.orderId },
            { kind: 'ALERT', alert: 'needsReview', refId: applied.orderId },
          ]
        : [];
    await this.notifier.send([...notices, ...review]);
    return { kind: 'WRITTEN', what: outcome.kind };
  }

  /** A failed read is a WAIT for this transfer, never an answer. */
  async guarded(transferId: string, look: () => Promise<LateCheck>): Promise<LateCheck> {
    try {
      return await look();
    } catch (error) {
      if (!(error instanceof TonGatewayError)) throw error;
      this.logger.warn(`transfer ${transferId}: late look waits (${error.reason})`);
      return wait('GATEWAY');
    }
  }
}
