import { describeErrorForLog } from '@repo/shared';

const MAX_LENGTH = 300;

/**
 * A log-safe one-liner for an error raised by grammY or a handler. grammY's HttpError message
 * can contain the Bot API URL (which embeds the token), so the text is scrubbed; update bodies
 * and contexts are never included. A database error raised by a handler is described from names
 * only, never its message (review M1).
 */
export function safeErrorText(error: unknown): string {
  return describeErrorForLog(error, MAX_LENGTH);
}
