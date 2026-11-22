import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

// List filters live in the URL search params (a reload, a shared link and Back keep them).
// A spec names each param, its default and, for a closed set, the allowed values: anything else
// in the URL falls back to the default, so a hand-edited link never turns into a 400 from the API.

export interface ParamSpec {
  default: string;
  /** Allowed values; omit for free text (search). */
  values?: readonly string[];
  /** Upper bound of free text (the API's `q` is at most 64). */
  maxLength?: number;
}

export type ListSpec = Readonly<Record<string, ParamSpec>>;
export type ListValues<S extends ListSpec> = { readonly [K in keyof S]: string };

const PAGE = 'page';
const MAX_PAGE = 10_000;

/**
 * Drops C0/C1 control characters (R-12): a hand-edited link with a NUL, a tab or a newline
 * must not reach the search box or the API's `q`.
 */
function stripControls(raw: string): string {
  let out = '';
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0x1f && (code < 0x7f || code > 0x9f)) out += char;
  }
  return out;
}

function readOne(spec: ParamSpec, raw: string | null): string {
  if (raw === null) return spec.default;
  const value = stripControls(raw).trim();
  if (spec.values) return spec.values.includes(value) ? value : spec.default;
  return value.slice(0, spec.maxLength ?? 64);
}

/** The filter values of a search string, defaults filled in. */
export function readListParams<S extends ListSpec>(
  search: URLSearchParams,
  spec: S,
): ListValues<S> {
  const out: Record<string, string> = {};
  for (const [key, one] of Object.entries(spec)) out[key] = readOne(one, search.get(key));
  return out as ListValues<S>;
}

/** The page number (1..10 000); anything else is page 1. */
export function readPage(search: URLSearchParams): number {
  const raw = search.get(PAGE);
  if (raw === null || !/^[1-9]\d{0,4}$/.test(raw)) return 1;
  return Math.min(Number(raw), MAX_PAGE);
}

/**
 * A new search string after a filter change: a value equal to its default is dropped (short,
 * canonical links), params outside the spec are kept, and the page goes back to 1.
 */
export function writeListParams(
  search: URLSearchParams,
  spec: ListSpec,
  patch: Readonly<Record<string, string>>,
): URLSearchParams {
  const next = new URLSearchParams(search);
  for (const [key, value] of Object.entries(patch)) {
    const one = spec[key];
    if (one === undefined) continue;
    if (value === one.default || value === '') next.delete(key);
    else next.set(key, value);
  }
  next.delete(PAGE);
  return next;
}

export function writePage(search: URLSearchParams, page: number): URLSearchParams {
  const next = new URLSearchParams(search);
  if (page <= 1) next.delete(PAGE);
  else next.set(PAGE, String(Math.min(page, MAX_PAGE)));
  return next;
}

/** The hook form of the above, bound to the router's search params. */
export function useListParams<S extends ListSpec>(spec: S) {
  const [search, setSearch] = useSearchParams();
  const values = useMemo(() => readListParams(search, spec), [search, spec]);
  const page = readPage(search);
  const set = useCallback(
    (patch: Partial<Record<keyof S & string, string>>) => {
      const clean = Object.fromEntries(
        Object.entries(patch).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      setSearch((current) => writeListParams(current, spec, clean), { replace: true });
    },
    [setSearch, spec],
  );
  const setPage = useCallback(
    (next: number, options?: { replace?: boolean }) =>
      setSearch((current) => writePage(current, next), { replace: options?.replace ?? false }),
    [setSearch],
  );
  const reset = useCallback(() => setSearch(new URLSearchParams(), { replace: true }), [setSearch]);
  return { values, page, set, setPage, reset };
}
