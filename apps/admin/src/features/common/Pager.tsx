import type { PageMeta } from '@repo/shared';
import { TablePager } from '@repo/ui';
import { useEffect } from 'react';
import { useTranslations } from 'use-intl';
import { formatCount } from '../../lib/format';
import { lastPage } from './pager-model';

interface Props {
  meta: PageMeta;
  /** `replace` is set when the pager corrects a page past the end (no new history entry). */
  onPage: (page: number, options?: { replace?: boolean }) => void;
}

/**
 * The list footer: "Jami 18 420 tadan 1–20" with previous / next (page in the URL). Nothing for an
 * empty list (R-8). A page past the end (a hand-edited link, rows gone since) moves to the last
 * page instead of showing an empty table under a "1–0" summary.
 */
export function Pager({ meta, onPage }: Props) {
  const t = useTranslations();
  const last = lastPage(meta);
  const past = meta.total > 0 && meta.page > last;
  useEffect(() => {
    if (past) onPage(last, { replace: true });
  }, [past, last, onPage]);
  if (meta.total === 0 || past) return null;
  const from = (meta.page - 1) * meta.limit + 1;
  const to = Math.min(meta.page * meta.limit, meta.total);
  return (
    <TablePager
      summary={t('admin.list.summary', {
        total: formatCount(meta.total),
        from: formatCount(from),
        to: formatCount(to),
      })}
      previousLabel={t('admin.list.previous')}
      nextLabel={t('admin.list.next')}
      hasPrevious={meta.page > 1}
      hasNext={to < meta.total}
      onPrevious={() => onPage(meta.page - 1)}
      onNext={() => onPage(meta.page + 1)}
    />
  );
}
