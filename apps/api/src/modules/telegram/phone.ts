const MIN_DIGITS = 7;
const MAX_DIGITS = 15; // E.164

/** `+<digits>` from whatever Telegram sends (it sometimes drops the `+`); null if not a phone. */
export function normalizePhone(raw: string): string | null {
  if (!/^\+?[\d\s()-]+$/.test(raw)) return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= MIN_DIGITS && digits.length <= MAX_DIGITS ? `+${digits}` : null;
}
