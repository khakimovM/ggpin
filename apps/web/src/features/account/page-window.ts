export type PageSlot = number | 'gap';

/**
 * The page buttons of the pager: always the first and last page, the current one and its
 * neighbours, a gap where pages are left out. Few pages are all shown.
 */
export function pageWindow(current: number, totalPages: number): PageSlot[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  const wanted = new Set([1, totalPages, current - 1, current, current + 1]);
  const pages = [...wanted].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  const slots: PageSlot[] = [];
  pages.forEach((page, index) => {
    const before = pages[index - 1];
    if (before !== undefined && page - before > 1) slots.push('gap');
    slots.push(page);
  });
  return slots;
}
