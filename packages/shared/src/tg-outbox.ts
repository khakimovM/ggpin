// Job contract for the `tg-outbox` queue (QUEUES.TG_OUTBOX): producers (api, worker alerts)
// enqueue pre-rendered messages, the api consumer sends them. Never put an OTP code in a job:
// jobs stay in Redis for days (QUEUE_JOB_DEFAULTS).
import { z } from 'zod';

/** Telegram's sendMessage text limit. */
export const TG_TEXT_MAX_LENGTH = 4096;

export const tgOutboxJobSchema = z.strictObject({
  // User chat ids only (digits); the bot never writes to groups.
  chatId: z.string().regex(/^\d{1,20}$/),
  // Pre-rendered HTML with user-controlled parts already escaped by the producer.
  text: z.string().min(1).max(TG_TEXT_MAX_LENGTH),
  replyMarkup: z.record(z.string(), z.unknown()).optional(),
  disableNotification: z.boolean().optional(),
});
export type TgOutboxJob = z.infer<typeof tgOutboxJobSchema>;

const SEGMENT = /^[A-Za-z0-9_]{1,64}$/;
const JOB_ID_MAX_LENGTH = 200;

/**
 * Builds a BullMQ custom job id from segments, e.g. `('order', orderId, 'delivered')` ->
 * `order-<id>-delivered`. BullMQ rejects ':' and purely numeric ids, and one id must always
 * mean one message, so segments are restricted to [A-Za-z0-9_] and joined with '-'.
 */
export function tgOutboxJobId(...segments: readonly string[]): string {
  if (segments.length < 2) throw new Error('tg-outbox job id needs at least two segments');
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) throw new Error('tg-outbox job id segment has invalid characters');
  }
  const id = segments.join('-');
  if (id.length > JOB_ID_MAX_LENGTH) throw new Error('tg-outbox job id is too long');
  return id;
}
