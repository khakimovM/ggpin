// What no admin read response may carry, for any role (S4 body scan): provider references and
// raw payloads, card numbers, hashes of tokens/sessions/requests/codes, OTP or other secrets, the
// bank message's Telegram ids and a P2P intent's verification amount (SA-S4-4).
const FORBIDDEN_KEY =
  /^(providerRef|providerTxnId|raw|pan|tokenHash|refreshHash|payTokenHash|textSha256|requestHash|idempotencyKey|inputSchema|codeHash|verifyAmountTiyin|senderId|tgMessageId)$/;
const SECRET_KEY = /otp|secret|password|mnemonic|cookie|initData/i;
const FULL_PAN = /\d{16}/;
// Test Telegram ids are long synthetic numbers (test-telegram-id.ts), not card numbers.
const NUMERIC_ID_KEYS = new Set(['telegramId']);

/** Every forbidden key path and every string holding 16 digits in a row, in `body`. */
export function leaks(body: unknown, allowPanAt: readonly string[] = []): string[] {
  const found: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      const key = path.slice(path.lastIndexOf('.') + 1);
      const exempt = allowPanAt.includes(path) || NUMERIC_ID_KEYS.has(key);
      if (FULL_PAN.test(value.replace(/[\s-]/g, '')) && !exempt) {
        found.push(`${path}: 16 digits`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${String(i)}]`));
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [key, inner] of Object.entries(value)) {
        if (FORBIDDEN_KEY.test(key) || SECRET_KEY.test(key)) found.push(`${path}.${key}`);
        walk(inner, `${path}.${key}`);
      }
    }
  };
  walk(body, '$');
  return found;
}
