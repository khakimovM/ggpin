'use client';

import type { CatalogCategory } from '@repo/shared';
import { Chip } from '@repo/ui';
import { useTranslations } from 'next-intl';

interface CategoryChipsProps {
  categories: readonly CatalogCategory[];
  /** The selected category slug, or undefined for "all". */
  value: string | undefined;
  onChange: (slug: string | undefined) => void;
  /** Show the product count in each chip (the web catalog does, the Mini App does not). */
  counts?: boolean;
  className?: string;
}

/** "Hammasi" plus one chip per category: toggle buttons, exactly one of them pressed. */
export function CategoryChips({
  categories,
  value,
  onChange,
  counts = false,
  className,
}: CategoryChipsProps) {
  const t = useTranslations('store.catalog.categories');
  return (
    <div
      role="group"
      aria-label={t('label')}
      // py-1 / -my-1: room for the chips' 44 px hit area, which overflow-x-auto would clip.
      className={`-mx-4 -my-1 flex gap-2 overflow-x-auto px-4 py-1 [scrollbar-width:none] md:mx-0 md:px-0 ${className ?? ''}`}
    >
      <Chip
        selected={value === undefined}
        onClick={() => onChange(undefined)}
        className="shrink-0 whitespace-nowrap"
      >
        {t('all')}
      </Chip>
      {categories.map((category) => (
        <Chip
          key={category.slug}
          selected={value === category.slug}
          onClick={() => onChange(category.slug)}
          className="shrink-0 whitespace-nowrap"
        >
          {counts
            ? t('withCount', { name: category.name, count: category.productCount })
            : category.name}
        </Chip>
      ))}
    </div>
  );
}
