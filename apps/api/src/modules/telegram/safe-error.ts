import { scrubSecretsInText } from '@repo/shared';

const MAX_LENGTH = 300;

/**
 * A log-safe one-liner for an error raised by grammY or a handler. grammY's HttpError message
 * can contain the Bot API URL (which embeds the token), so the text is scrubbed; update bodies
 * and contexts are never included.
 */
export function safeErrorText(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : 'non-Error thrown';
  return scrubSecretsInText(raw).slice(0, MAX_LENGTH);
}
