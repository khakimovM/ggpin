import {
  RECONCILE_MISMATCH_CODES,
  ResourceIdSchema,
  type AdminReconcileResponse,
  type ReconcileMismatchCode,
} from '@repo/shared';
import { iso } from '../read/admin-read-view';

type Day = AdminReconcileResponse[number];
const EXAMPLES_MAX = 20;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** A whole, non-negative count; anything else in the stored JSON reads as 0. */
const count = (value: unknown): number => (isCount(value) ? value : 0);

const ids = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [])
    .filter((id): id is string => ResourceIdSchema.safeParse(id).success)
    .slice(0, EXAMPLES_MAX);

/** `20261117` (the worker's `tashkentDayKey`) -> `2026-11-17`. */
function dayOf(targetId: string, createdAt: Date): string {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(targetId);
  if (match === null) return iso(createdAt).slice(0, 10);
  return `${match[1] ?? ''}-${match[2] ?? ''}-${match[3] ?? ''}`;
}

/**
 * One `PAYMENT_RECONCILE` audit row (docs/05 §10) as the reconcile screen reads it. The row is
 * free JSON written by the worker, so every field is read defensively; `ok` is recomputed the
 * worker's way (no mismatch AND the history re-scan was `ok`) and is false when in doubt.
 */
export function toAdminReconcileDay(row: {
  id: string;
  targetId: string;
  after: unknown;
  createdAt: Date;
}): Day {
  const after = record(row.after);
  const storedMismatches = record(after['mismatches']);
  const storedExamples = record(after['examples']);
  const perCode = <T>(read: (code: ReconcileMismatchCode) => T): Record<ReconcileMismatchCode, T> =>
    Object.fromEntries(RECONCILE_MISMATCH_CODES.map((code) => [code, read(code)])) as Record<
      ReconcileMismatchCode,
      T
    >;
  const mismatches = perCode((code) => count(storedMismatches[code]));
  const historyScan = typeof after['historyScan'] === 'string' ? after['historyScan'] : 'unknown';
  const total = RECONCILE_MISMATCH_CODES.reduce((sum, code) => sum + mismatches[code], 0);
  // A mismatch count that is there but is not a count (-5, "3", 1.5, null) is a row we cannot
  // read, and a row we cannot read is not a clean day (CR m1).
  const unreadable = RECONCILE_MISMATCH_CODES.some(
    (code) => code in storedMismatches && !isCount(storedMismatches[code]),
  );
  return {
    day: dayOf(row.targetId, row.createdAt),
    auditId: row.id,
    createdAt: iso(row.createdAt),
    ok: total === 0 && !unreadable && historyScan === 'ok',
    checkedMessages: count(after['checkedMessages']),
    debits: count(after['debits']),
    openReviews: count(after['openReviews']),
    historyScan: historyScan.slice(0, 32),
    mismatches,
    examples: perCode((code) => ids(storedExamples[code])),
  };
}
