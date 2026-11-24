// The product order as the list edits it before saving (plan S8b): drag, the arrow buttons and
// Alt+↑/↓ all end here, so they move rows the same way. The saved order is always the full set
// (docs/04 reorder, `PRODUCT_SET_MISMATCH`).

/** `ids` with the row at `index` moved by `delta` places (clamped to the list). */
export function moveBy(ids: readonly string[], index: number, delta: number): string[] {
  const target = Math.min(Math.max(index + delta, 0), ids.length - 1);
  if (index < 0 || index >= ids.length || target === index) return [...ids];
  const next = [...ids];
  const [moved] = next.splice(index, 1);
  if (moved !== undefined) next.splice(target, 0, moved);
  return next;
}

/** `ids` with `from` dropped onto `onto`'s place (drag and drop: the rows between shift). */
export function moveOnto(ids: readonly string[], from: string, onto: string): string[] {
  const fromIndex = ids.indexOf(from);
  const ontoIndex = ids.indexOf(onto);
  if (fromIndex < 0 || ontoIndex < 0) return [...ids];
  return moveBy(ids, fromIndex, ontoIndex - fromIndex);
}

/** The saved order: products by `sort`, ties by id (what the API's list returns). */
export function savedOrder(rows: readonly { id: string; sort: number }[]): string[] {
  return [...rows]
    .sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row) => row.id);
}

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
