import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { QUEUES, describeErrorForLog } from '@repo/shared';
import type { Job } from 'bullmq';
import { FragmentKeepaliveService, type KeepaliveResult } from './fragment-keepalive.service';

/**
 * Consumer of `fragment-keepalive` (every FRAGMENT_KEEPALIVE_EVERY_MS, attempts 1: the next tick
 * is the retry; queues.ts). Concurrency 1: one look at the session at a time per replica, and the
 * state moves are compare-and-set across replicas. Logs the result word only.
 */
@Processor(QUEUES.FRAGMENT_KEEPALIVE, { concurrency: 1 })
export class FragmentKeepaliveProcessor extends WorkerHost {
  private readonly logger = new Logger(FragmentKeepaliveProcessor.name);

  constructor(private readonly keepalive: FragmentKeepaliveService) {
    super();
  }

  async process(): Promise<KeepaliveResult> {
    const result = await this.keepalive.tick();
    if (result !== 'OK' && result !== 'DISABLED' && result !== 'NONE') {
      this.logger.warn(`fragment-keepalive: ${result}`);
    }
    return result;
  }

  @OnWorkerEvent('failed')
  onFailed(_job: Pick<Job, 'id'> | undefined, error: Error): void {
    this.logger.warn(`fragment-keepalive failed: ${describeErrorForLog(error)}`);
  }
}
