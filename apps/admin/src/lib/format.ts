import { formatMajor, formatMoney, type Currency } from '@repo/shared';
import { ADMIN_LOCALE, ADMIN_TIME_ZONE } from './i18n';

// Display helpers of the admin panel. Money arrives as decimal strings of minor units and is
// only formatted here (BigInt, never Number); dates are shown in Tashkent time.

const NARROW_NBSP = ' ';
const MINUS = '−';

/**
 * A tiyin amount from the API (a decimal string) as the bare number of so'm: "1 255 000". The
 * unit text comes from i18n. The string is turned into a BigInt, never into a Number.
 */
export function formatTiyin(amountTiyin: string): string {
  return formatMoney(BigInt(amountTiyin), ADMIN_LOCALE);
}

/** A signed amount with its sign always written: "+50 000", "−110 000", "0". */
export function formatSignedTiyin(amountTiyin: string): string {
  const value = BigInt(amountTiyin);
  const text = formatMoney(value, ADMIN_LOCALE);
  return value > 0n ? `+${text}` : text;
}

function groupDigits(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+$)/g, NARROW_NBSP);
}

/**
 * Minor units of another currency (nanoTON, micro-USDT) as a localised decimal: "182,4",
 * "1 240". `minFraction` pads the fraction ("182,40"); digits are never cut or rounded.
 */
export function formatMinor(currency: Currency, minor: string, minFraction = 0): string {
  const major = formatMajor(currency, BigInt(minor));
  const negative = major.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? major.slice(1) : major).split('.');
  const padded = fraction.padEnd(minFraction, '0');
  return `${negative ? MINUS : ''}${groupDigits(whole)}${padded ? `,${padded}` : ''}`;
}

/**
 * `part / whole` as a plain ratio (0..1) for chart geometry only. Computed in BigInt basis points
 * first, so no money amount ever becomes a Number; only the dimensionless share does.
 */
export function ratioOf(part: string | bigint, whole: string | bigint): number {
  const p = BigInt(part);
  const w = BigInt(whole);
  if (w <= 0n || p <= 0n) return 0;
  const bps = (p * 10_000n) / w;
  return Number(bps) / 10_000;
}

/** The largest of several tiyin strings (0 for none). */
export function maxTiyin(values: readonly string[]): bigint {
  return values.reduce((max, value) => {
    const amount = BigInt(value);
    return amount > max ? amount : max;
  }, 0n);
}

export interface CompactSom {
  value: string;
  unit: 'mln' | 'ming' | 'none';
}

/** An axis label of a so'm amount: 500 000 000 tiyin -> { "5", mln }; one decimal at most. */
export function compactSom(amountTiyin: bigint): CompactSom {
  const som = amountTiyin / 100n;
  const scaled = (divisor: bigint): string => {
    const tenths = (som * 10n) / divisor;
    const whole = tenths / 10n;
    const rest = tenths % 10n;
    return rest === 0n ? groupDigits(whole.toString()) : `${groupDigits(whole.toString())},${rest}`;
  };
  if (som >= 1_000_000n) return { value: scaled(1_000_000n), unit: 'mln' };
  if (som >= 1_000n) return { value: scaled(1_000n), unit: 'ming' };
  return { value: groupDigits(som.toString()), unit: 'none' };
}

/** A count grouped like money (narrow no-break space): "18 420". Counts are safe integers. */
export function formatCount(value: number): string {
  return `${value < 0 ? MINUS : ''}${groupDigits(String(Math.abs(Math.trunc(value))))}`;
}

/**
 * Basis points as a percent number without the sign, one decimal at most and a decimal comma
 * (R-10): 9 940 -> "99,4", 10 000 -> "100", 5 -> "0,1". Integer math only, so the output never
 * depends on the runtime's locale data.
 */
export function formatBps(bps: number): string {
  const tenths = Math.round(Math.abs(bps) / 10);
  const whole = Math.trunc(tenths / 10);
  const rest = tenths % 10;
  const sign = bps < 0 && tenths > 0 ? MINUS : '';
  return `${sign}${groupDigits(String(whole))}${rest ? `,${rest}` : ''}`;
}

type DatePart = 'day' | 'month' | 'year' | 'hour' | 'minute' | 'second';

const tashkentFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: ADMIN_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/**
 * The calendar fields of an instant in Tashkent time, read with formatToParts: the layout is ours
 * (the design's "dd.mm.yyyy hh:mm"), not whatever separators the runtime's locale data prefers.
 */
function tashkent(iso: string): Record<DatePart, string> {
  const fields: Record<DatePart, string> = {
    day: '',
    month: '',
    year: '',
    hour: '',
    minute: '',
    second: '',
  };
  for (const part of tashkentFormat.formatToParts(new Date(iso))) {
    if (part.type in fields) fields[part.type as DatePart] = part.value;
  }
  return fields;
}

/** Date and time in Tashkent time: "17.11.2026 14:02". */
export function formatDateTime(iso: string): string {
  const d = tashkent(iso);
  return `${d.day}.${d.month}.${d.year} ${d.hour}:${d.minute}`;
}

/** "17.11.2026". */
export function formatDate(iso: string): string {
  const d = tashkent(iso);
  return `${d.day}.${d.month}.${d.year}`;
}

/** "14:02:11". */
export function formatTime(iso: string): string {
  const d = tashkent(iso);
  return `${d.hour}:${d.minute}:${d.second}`;
}

/** Whether two instants fall on the same Tashkent calendar day. */
export function sameTashkentDay(a: string, b: string): boolean {
  return formatDate(a) === formatDate(b);
}

/** A Tashkent calendar day "2026-11-17" (dashboard, reconcile) as day and month, like formatShortDate. */
export function formatDay(day: string): string {
  return formatShortDate(`${day}T12:00:00+05:00`);
}

/** A countdown as m:ss ("2:41"); negative values show as 0:00. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

/** "7cc0…11be": the head and tail of a long hash or address, for tables. */
export function shortHash(value: string, keep = 4): string {
  return value.length <= keep * 2 + 1 ? value : `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

const CURRENCIES: readonly Currency[] = ['UZS', 'USDT', 'TON', 'STARS'];

/** A cost in its own currency ("3,42 TON"); an unknown currency code shows the raw minor units. */
export function formatCost(currency: string, minor: string): string {
  const known = CURRENCIES.find((code) => code === currency);
  return known ? `${formatMinor(known, minor)} ${known}` : `${minor} ${currency}`;
}

/** "17.11": day and month of an instant in Tashkent time (chart axes). */
export function formatShortDate(iso: string): string {
  const d = tashkent(iso);
  return `${d.day}.${d.month}`;
}
