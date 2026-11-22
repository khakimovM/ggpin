// Helpers of the dev mock's read fixtures. Times are fixed (17.11.2026, 14:12 in Tashkent), so a
// screenshot is the same on every run; ids follow the API's `[A-Za-z0-9_-]` shape.
import { LIST_DEFAULT_LIMIT } from '@repo/shared';
import { readMockState } from './mock-state';
import { ok, type MockReply } from './router';

export const MOCK_NOW = Date.parse('2026-11-17T09:12:04Z');

/** An ISO instant `minutes` before the mock's "now". */
export function ago(minutes: number): string {
  return new Date(MOCK_NOW - minutes * 60_000).toISOString();
}

/** A stable mock id: `mk` + kind + number, padded like a cuid. */
export function mid(kind: string, n: number): string {
  return `mk${kind}${String(n).padStart(6, '0')}`;
}

function intParam(query: URLSearchParams, key: string, fallback: number, max: number): number {
  const raw = query.get(key);
  if (raw === null || !/^[1-9]\d{0,5}$/.test(raw)) return fallback;
  return Math.min(Number(raw), max);
}

/**
 * One page of a list, like the API: `meta { page, limit, total }`. The `empty` scenario of the
 * mock state answers every list with no rows (the empty-state screenshots).
 */
export function pageOf<T>(items: readonly T[], query: URLSearchParams): MockReply {
  const rows = readMockState().scenario === 'empty' ? [] : items;
  const limit = intParam(query, 'limit', LIST_DEFAULT_LIMIT, 100);
  const page = intParam(query, 'page', 1, 10_000);
  const start = (page - 1) * limit;
  return { ...ok(rows.slice(start, start + limit)), meta: { page, limit, total: rows.length } };
}

/** A plain array answer that honours the `empty` scenario too. */
export function listOf<T>(items: readonly T[]): MockReply {
  return ok(readMockState().scenario === 'empty' ? [] : items);
}

/** Keeps the rows whose `field` equals the query param, when that param is given. */
export function whereParam<T>(
  items: readonly T[],
  query: URLSearchParams,
  param: string,
  field: (item: T) => string | null,
): readonly T[] {
  const wanted = query.get(param);
  return wanted === null ? items : items.filter((item) => field(item) === wanted);
}

/** `from` (inclusive) on an ISO field. */
export function since<T>(
  items: readonly T[],
  query: URLSearchParams,
  field: (item: T) => string,
): readonly T[] {
  const from = query.get('from');
  if (from === null) return items;
  const bound = Date.parse(from);
  return items.filter((item) => Date.parse(field(item)) >= bound);
}
