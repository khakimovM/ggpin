// Asia/Tashkent is UTC+5 all year (no daylight saving since 1992). One constant for every place
// that thinks in the owner's and the bank's local time: the bank-message parser (the bots print
// local time; assumption in docs/05-PAYMENTS.md §5 rule 5, confirmed in phase 4 S11), the
// monthly card cap, the night hours of the silence alert and the reconciliation day.

export const TASHKENT_UTC_OFFSET_MINUTES = 5 * 60;

const OFFSET_MS = TASHKENT_UTC_OFFSET_MINUTES * 60_000;

/** Start of the current calendar month in Asia/Tashkent, as a UTC instant. */
export function tashkentMonthStart(now: Date): Date {
  const local = new Date(now.getTime() + OFFSET_MS);
  const startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1);
  return new Date(startLocal - OFFSET_MS);
}

/**
 * The Asia/Tashkent calendar day of an instant as `yyyymmdd`: the daily reconciliation's key
 * (its AuditLog `targetId` and its alert `refId`, docs/05 §10).
 */
export function tashkentDayKey(now: Date): string {
  const local = new Date(now.getTime() + OFFSET_MS);
  const y = String(local.getUTCFullYear()).padStart(4, '0');
  const m = String(local.getUTCMonth() + 1).padStart(2, '0');
  const d = String(local.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}
