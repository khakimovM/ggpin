import { Inject, Injectable, Logger } from '@nestjs/common';
import { describeErrorForLog } from '@repo/shared';
import { OrderReconcileRepository } from './order-reconcile.repository';
import {
  RECONCILE_STEPS,
  describeReport,
  type ReconcileStep,
  type StepReport,
} from './reconcile-step';

// One tick of the order reconciler (phase 5 S9, D-64 (1)): the registered steps in their fixed
// order (transfers, review; later stale S9d, held S9e, late facts S9f, audit effects S9h), each in
// its own try/catch so one failing step never stops the others, every one on the SAME database
// clock read once at the start. Never signs, never pays, never takes `lock:ton-wallet`: the steps
// only read, ask the TON module to look at the chain, and call the money helpers.

export interface TickReport {
  readonly nowMs: number;
  readonly steps: readonly StepReport[];
  /** The steps that threw (their name only; the error is in the log). */
  readonly failed: readonly string[];
}

@Injectable()
export class OrderReconcileService {
  private readonly logger = new Logger(OrderReconcileService.name);

  constructor(
    private readonly repository: OrderReconcileRepository,
    @Inject(RECONCILE_STEPS) private readonly steps: readonly ReconcileStep[],
  ) {}

  async tick(): Promise<TickReport> {
    const nowMs = await this.repository.databaseNowMs();
    const reports: StepReport[] = [];
    const failed: string[] = [];
    for (const step of this.steps) {
      try {
        const report = await step.run({ nowMs });
        reports.push(report);
        this.logger.log(`reconcile:orders ${describeReport(report)}`);
      } catch (error) {
        failed.push(step.name);
        this.logger.error(
          `reconcile:orders step=${step.name} failed: ${describeErrorForLog(error, 200)}`,
        );
      }
    }
    return { nowMs, steps: reports, failed };
  }
}
