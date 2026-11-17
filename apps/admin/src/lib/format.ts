import { formatMoney } from '@repo/shared';
import { ADMIN_LOCALE, ADMIN_TIME_ZONE } from './i18n';

/**
 * A tiyin amount from the API (a decimal string) as the bare number of so'm: "1 255 000". The
 * unit text comes from i18n. The string is turned into a BigInt, never into a Number.
 */
export function formatTiyin(amountTiyin: string): string {
  return formatMoney(BigInt(amountTiyin), ADMIN_LOCALE);
}

/** Date and time in Tashkent time: "17.11.2026, 14:02". */
export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('uz-UZ', {
    timeZone: ADMIN_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

/** A countdown as m:ss ("2:41"); negative values show as 0:00. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}
