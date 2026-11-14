import { describeErrorForLog } from '@repo/shared';
import { BotError } from 'grammy';

const MAX_LENGTH = 300;

/**
 * A log-safe one-liner for an error raised by grammY or a handler. grammY's HttpError message
 * can contain the Bot API URL (which embeds the token), so the text is scrubbed; update bodies
 * and contexts are never included. A database error raised by a handler is described from names
 * only, never its message (review M1).
 *
 * grammY wraps a handler's error in a BotError whose MESSAGE repeats the inner one ("Error in
 * middleware: <message>") and keeps it in `error`, not in `cause` (S2 review nit 2). So a BotError
 * is described by its inner error: a wrapped database error is then found and redacted, and the
 * wrapper's own message (with the same text) is never copied.
 */
export function safeErrorText(error: unknown): string {
  if (error instanceof BotError) {
    return `BotError caused by ${describeErrorForLog(error.error, MAX_LENGTH)}`.slice(
      0,
      MAX_LENGTH,
    );
  }
  return describeErrorForLog(error, MAX_LENGTH);
}
