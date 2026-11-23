import { auditJson, catalogDiff } from '../admin-catalog-write.diff';

describe('catalogDiff (S8a)', () => {
  const row = { nameUz: 'A', helpUz: 'yordam' as string | null, sort: 1, minMarginTiyin: 5n };

  it('only changed fields, sorted, bigint as a string', () => {
    const diff = catalogDiff(row, { sort: 2, nameUz: 'A', minMarginTiyin: 7n });
    expect(diff.changed).toBe(true);
    expect(diff.data).toEqual({ minMarginTiyin: 7n, sort: 2 });
    expect(diff.before).toEqual({ minMarginTiyin: '5', sort: 1 });
    expect(diff.after).toEqual({ minMarginTiyin: '7', sort: 2 });
    expect(Object.keys(diff.after)).toEqual(['minMarginTiyin', 'sort']);
  });

  it('undefined is "not asked", null clears a text', () => {
    expect(catalogDiff(row, { helpUz: undefined }).changed).toBe(false);
    const cleared = catalogDiff(row, { helpUz: null });
    expect(cleared.before).toEqual({ helpUz: 'yordam' });
    expect(cleared.after).toEqual({ helpUz: null });
  });

  it('the same values: no change', () => {
    const diff = catalogDiff(row, { nameUz: 'A', sort: 1, minMarginTiyin: 5n });
    expect(diff).toEqual({ data: {}, before: {}, after: {}, changed: false });
  });

  it('auditJson: every field, sorted, JSON-safe', () => {
    expect(auditJson({ b: 1n, a: null, c: true })).toEqual({ a: null, b: '1', c: true });
    expect(Object.keys(auditJson({ b: 1, a: 2 }))).toEqual(['a', 'b']);
  });
});
