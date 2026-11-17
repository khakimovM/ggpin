import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { ADMIN_RETRYABLE_QUEUES, QUEUE_NAMES, type AdminInfraQueuesResponse } from '@repo/shared';
import type { Queue } from 'bullmq';
import { withinMs } from '../../payments/within-ms';

/** One Redis round trip per queue must not hold an admin page (or the dashboard) open. */
const QUEUE_READ_TIMEOUT_MS = 1_000;

const isRetryable = (name: string): boolean =>
  (ADMIN_RETRYABLE_QUEUES as readonly string[]).includes(name);

/**
 * Job counts of every BullMQ queue the API registers (all of `QUEUE_NAMES`). Counts and the pause
 * flag only: no job payload (a notify or fulfill job carries user data) ever leaves here.
 */
@Injectable()
export class AdminQueuesReader {
  constructor(private readonly moduleRef: ModuleRef) {}

  async counts(): Promise<AdminInfraQueuesResponse> {
    return Promise.all(
      QUEUE_NAMES.map(async (name) => {
        const queue = this.moduleRef.get<Queue>(getQueueToken(name), { strict: false });
        const [counts, paused] = await withinMs(
          Promise.all([
            queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
            queue.isPaused(),
          ]),
          QUEUE_READ_TIMEOUT_MS,
          `queue ${name}`,
        );
        return {
          name,
          waiting: counts['waiting'] ?? 0,
          active: counts['active'] ?? 0,
          delayed: counts['delayed'] ?? 0,
          failed: counts['failed'] ?? 0,
          paused,
          retryable: isRetryable(name),
        };
      }),
    );
  }
}
