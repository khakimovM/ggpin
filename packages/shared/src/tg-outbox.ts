// Job contract for the `tg-outbox` queue (QUEUES.TG_OUTBOX): producers (api, worker alerts)
// enqueue pre-rendered messages, the api consumer sends them. Never put an OTP code in a job:
// jobs stay in Redis for days (QUEUE_JOB_DEFAULTS).
import { z } from 'zod';

/** Telegram's sendMessage text limit. */
export const TG_TEXT_MAX_LENGTH = 4096;

/** Telegram caps callback_data at 64 BYTES; printable ASCII keeps bytes equal to characters. */
export const TG_CALLBACK_DATA_PATTERN = /^[ -~]{1,64}$/;

const BUTTON_TEXT_MAX_LENGTH = 64;
const KEYBOARD_MAX_ROWS = 8;
const KEYBOARD_MAX_BUTTONS_PER_ROW = 8;

const inlineButtonSchema = z.union([
  z.strictObject({
    text: z.string().min(1).max(BUTTON_TEXT_MAX_LENGTH),
    callback_data: z.string().regex(TG_CALLBACK_DATA_PATTERN),
  }),
  z.strictObject({
    text: z.string().min(1).max(BUTTON_TEXT_MAX_LENGTH),
    url: z.url({ protocol: /^https?$/ }),
  }),
]);

/** Inline keyboard as Telegram expects it (`reply_markup` of sendMessage), strictly shaped. */
export const tgInlineKeyboardSchema = z.strictObject({
  inline_keyboard: z
    .array(z.array(inlineButtonSchema).min(1).max(KEYBOARD_MAX_BUTTONS_PER_ROW))
    .max(KEYBOARD_MAX_ROWS),
});
export type TgInlineKeyboard = z.infer<typeof tgInlineKeyboardSchema>;

/**
 * A Telegram USER chat id: positive, no leading zero, at most 20 digits. Group and channel ids
 * are negative, and the outbox never writes to them; the API and worker env use the same
 * pattern for OWNER_ALERT_CHAT_ID so a bad id fails at boot, not on the first alert.
 */
export const TG_USER_CHAT_ID_PATTERN = /^[1-9]\d{0,19}$/;

export const tgOutboxJobSchema = z.strictObject({
  // User chat ids only; the bot never writes to groups.
  chatId: z.string().regex(TG_USER_CHAT_ID_PATTERN),
  // Pre-rendered HTML with user-controlled parts already escaped by the producer.
  text: z.string().min(1).max(TG_TEXT_MAX_LENGTH),
  replyMarkup: tgInlineKeyboardSchema.optional(),
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
