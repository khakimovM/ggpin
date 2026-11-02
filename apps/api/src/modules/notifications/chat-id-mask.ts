/** Keeps the last 4 digits so a log line can be correlated without storing the full chat id. */
export function maskChatId(chatId: string): string {
  return `***${chatId.slice(-4)}`;
}
