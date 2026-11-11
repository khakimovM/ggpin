/** Keeps the last 4 digits so a log line can be correlated without storing the full chat id. */
export function maskChatId(chatId: string): string {
  return `***${chatId.slice(-4)}`;
}

// A trailing "-<digits>" of 5+ digits: the chat id segment of an owner-alert job id, for log lines
// written before the payload (and so its chatId) is known to be valid.
const TRAILING_CHAT_SEGMENT = /-[1-9]\d{4,19}$/;

/**
 * A job id that is safe to log (D-53): owner-alert and webhook-alert outbox job ids END with the
 * recipient's chat id (`alert-chainBreak-r9-111111111`), and a full Telegram id must not reach the
 * logs. The segment equal to `chatId` is masked; without a known chat id, any trailing id-like
 * segment is.
 */
export function maskChatInJobId(jobId: string, chatId?: string): string {
  if (chatId !== undefined && jobId.endsWith(`-${chatId}`)) {
    return `${jobId.slice(0, -chatId.length)}${maskChatId(chatId)}`;
  }
  return jobId.replace(TRAILING_CHAT_SEGMENT, (segment) => `-${maskChatId(segment.slice(1))}`);
}
