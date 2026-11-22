// Line diff of an audit entry's `before` / `after` (AdminOps.dc.html "pricing.update ·
// o‘zgarishlar"): one line per top-level field, "-" for the old value, "+" for the new one.

export interface DiffLine {
  sign: '+' | '-' | ' ';
  key: string;
  value: string;
}

type Snapshot = Readonly<Record<string, unknown>> | null;

function show(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return JSON.stringify(value) ?? 'undefined';
}

/** Fields in a stable order; an unchanged field is one context line, a changed one is - then +. */
export function auditDiff(before: Snapshot, after: Snapshot): DiffLine[] {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
  return keys.flatMap((key): DiffLine[] => {
    const had = before !== null && Object.hasOwn(before, key);
    const has = after !== null && Object.hasOwn(after, key);
    const old = had && before ? show(before[key]) : '';
    const now = has && after ? show(after[key]) : '';
    if (had && has && old === now) return [{ sign: ' ', key, value: now }];
    return [
      ...(had ? [{ sign: '-' as const, key, value: old }] : []),
      ...(has ? [{ sign: '+' as const, key, value: now }] : []),
    ];
  });
}
