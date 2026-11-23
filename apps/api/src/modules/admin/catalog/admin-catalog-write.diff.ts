// The diff of a catalog write (docs/04 «Katalog», CR-M2): only the fields whose value really
// changes are written, audited (before/after) and answered as applied. A field asked with the
// value it already has is not a change; a write with no change writes nothing at all.

export type CatalogValue = string | number | boolean | bigint | null;
export type JsonScalar = string | number | boolean | null;
export type CatalogRecord = Record<string, CatalogValue>;

export interface CatalogDiff<T extends CatalogRecord> {
  /** The columns to write: the changed fields with their new value. */
  readonly data: Partial<T>;
  /** Old values of the changed fields, JSON-safe (bigint as a decimal string). */
  readonly before: Record<string, JsonScalar>;
  /** New values of the changed fields, JSON-safe. */
  readonly after: Record<string, JsonScalar>;
  readonly changed: boolean;
}

const json = (value: CatalogValue): JsonScalar =>
  typeof value === 'bigint' ? value.toString() : value;

/**
 * Compares the asked fields with the current row. `undefined` in `asked` means "not asked";
 * `null` is a value (clear the text). Keys are visited in sorted order so the audit JSON is
 * stable.
 */
export function catalogDiff<T extends CatalogRecord>(
  current: Readonly<T>,
  asked: Readonly<{ [P in keyof T]?: T[P] | undefined }>,
): CatalogDiff<T> {
  const data: Partial<T> = {};
  const before: Record<string, JsonScalar> = {};
  const after: Record<string, JsonScalar> = {};
  const keys = (Object.keys(asked) as (keyof T & string)[]).sort();
  for (const key of keys) {
    const next = asked[key];
    if (next === undefined) continue;
    const old = current[key];
    if (old === next) continue;
    data[key] = next;
    before[key] = json(old);
    after[key] = json(next);
  }
  return { data, before, after, changed: Object.keys(after).length > 0 };
}

/** Every field of a new row, JSON-safe (a created package is audited whole). */
export function auditJson(record: Readonly<CatalogRecord>): Record<string, JsonScalar> {
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, json(record[key] ?? null)]),
  );
}
