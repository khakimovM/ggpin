'use client';

import { useTranslations } from 'next-intl';
import { Skeleton } from '@repo/ui';
import { useCategories } from '../catalog/use-categories';

const ROW =
  'flex h-12 w-full items-center gap-2.5 rounded-xl px-3 text-left text-sm font-extrabold hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring';

/** Store.dc.html catalog, desktop: the categories as a column with their product counts. */
export function CategorySidebar({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (slug: string | undefined) => void;
}) {
  const t = useTranslations('store.catalog.categories');
  const categories = useCategories();
  if (categories.isPending) {
    // Hidden below 1024 px like the sidebar itself: a hidden column must not leave a gap.
    return <Skeleton className="hidden h-[220px] rounded-[20px] lg:block" />;
  }
  const entries = categories.data ?? [];
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, entry) => sum + entry.productCount, 0);

  const row = (slug: string | undefined, label: string, count: number) => {
    const on = value === slug;
    return (
      <button
        key={slug ?? 'all'}
        type="button"
        aria-pressed={on}
        onClick={() => onChange(slug)}
        className={`${ROW} ${on ? 'bg-primary-soft text-primary-soft-foreground' : 'text-foreground'}`}
      >
        <span className="flex-1">{label}</span>
        <span
          className={`h-[22px] min-w-[26px] rounded-full px-[7px] text-center text-[11px] leading-[22px] font-extrabold ${on ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground-secondary'}`}
        >
          {count}
        </span>
      </button>
    );
  };

  return (
    <aside
      aria-label={t('label')}
      className="sticky top-24 hidden flex-col gap-1 rounded-[20px] border border-border bg-card p-2 lg:flex"
    >
      <span className="px-3 pt-2.5 pb-2 text-xs leading-4 font-bold tracking-[.06em] text-foreground-muted uppercase">
        {t('label')}
      </span>
      {row(undefined, t('all'), total)}
      {entries.map((entry) => row(entry.slug, entry.name, entry.productCount))}
    </aside>
  );
}
