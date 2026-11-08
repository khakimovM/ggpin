import type { Logger } from '@nestjs/common';
import { scrubSecretsInText } from '@repo/shared';

/** A BullMQ repeat rule: a fixed interval, or a cron pattern read in a time zone. */
export type ScheduleRule =
  { readonly every: number } | { readonly pattern: string; readonly tz: string };

/**
 * The one producer call a cron scheduler makes; BullMQ's Queue satisfies it. Typed narrowly so
 * unit tests pass a plain fake instead of casting one to Queue.
 */
export interface SchedulerQueue {
  upsertJobScheduler(
    id: string,
    repeat: ScheduleRule,
    template: { name: string; data: object },
  ): Promise<unknown>;
}

/**
 * Registers one repeating job under a fixed scheduler id (upserting the same id again replaces
 * it, so N boots or N workers leave one scheduler). Never rejects: a Redis failure is logged
 * (scrubbed: the error may quote the Redis URL) and the next boot retries.
 */
export async function upsertBootSchedule(
  queue: SchedulerQueue,
  logger: Logger,
  schedule: { readonly id: string; readonly rule: ScheduleRule; readonly jobName: string },
): Promise<void> {
  try {
    await queue.upsertJobScheduler(schedule.id, schedule.rule, {
      name: schedule.jobName,
      data: {},
    });
    logger.log(`scheduled ${schedule.id}`);
  } catch (error) {
    const reason = error instanceof Error ? scrubSecretsInText(error.message) : 'non-Error thrown';
    logger.error(`scheduling ${schedule.id} failed: ${reason}`);
  }
}
