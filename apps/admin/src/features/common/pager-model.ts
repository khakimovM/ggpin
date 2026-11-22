import type { PageMeta } from '@repo/shared';

/** The last page of a list (1 for an empty one). */
export function lastPage(meta: Pick<PageMeta, 'total' | 'limit'>): number {
  if (meta.total <= 0 || meta.limit <= 0) return 1;
  return Math.ceil(meta.total / meta.limit);
}
