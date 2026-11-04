import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  PRICE_SYNC_EVERY_MS,
  PRICE_SYNC_JOBS,
  QUEUES,
  scrubSecretsInText,
  type PriceSyncJobName,
} from '@repo/shared';

/** Fixed scheduler ids: upserting the same id again replaces it, so N boots leave 2 schedulers. */
export const priceSyncSchedulerId = (name: PriceSyncJobName): string =>
  `${QUEUES.PRICE_SYNC}:${name}`;

/**
 * The two producer calls the scheduler makes; BullMQ's Queue satisfies it. Typed narrowly so
 * the unit test passes a plain fake instead of casting one to Queue.
 */
export interface PriceSyncQueue {
  upsertJobScheduler(
    id: string,
    repeat: { every: number },
    template: { name: string; data: object },
  ): Promise<{ delay: number }>;
  add(name: string, data: object): Promise<unknown>;
}

const JOB_NAMES: readonly PriceSyncJobName[] = [PRICE_SYNC_JOBS.FX, PRICE_SYNC_JOBS.COST];

/**
 * Registers the repeating `fx` and `cost` jobs on the price-sync queue (every
 * PRICE_SYNC_EVERY_MS) and makes sure each runs once right after boot.
 *
 * Boot is not blocked on Redis: scheduling runs in the background and a failure is logged (the
 * next boot retries). Without schedulers no prices are written, so quotes stop after 30
 * minutes: the safe direction.
 */
@Injectable()
export class PriceSyncScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(PriceSyncScheduler.name);
  private scheduled: Promise<void> = Promise.resolve();

  constructor(@InjectQueue(QUEUES.PRICE_SYNC) private readonly queue: PriceSyncQueue) {}

  onApplicationBootstrap(): void {
    this.scheduled = this.schedule();
  }

  /** Settles when boot scheduling has finished or failed (never rejects); for tests. */
  whenScheduled(): Promise<void> {
    return this.scheduled;
  }

  private async schedule(): Promise<void> {
    try {
      for (const name of JOB_NAMES) {
        const next = await this.queue.upsertJobScheduler(
          priceSyncSchedulerId(name),
          { every: PRICE_SYNC_EVERY_MS },
          { name, data: {} },
        );
        // A brand-new scheduler runs at once (delay 0). An existing one keeps its time slot, so
        // its next run may be minutes away: add one immediate run so a restart (e.g. after
        // the rates went stale) refreshes prices right away.
        if (next.delay > 0) await this.queue.add(name, {});
      }
      this.logger.log(
        `price sync scheduled: ${JOB_NAMES.join(', ')} every ${PRICE_SYNC_EVERY_MS} ms`,
      );
    } catch (error) {
      const reason =
        error instanceof Error ? scrubSecretsInText(error.message) : 'non-Error thrown';
      this.logger.error(`price sync scheduling failed: ${reason}`);
    }
  }
}
