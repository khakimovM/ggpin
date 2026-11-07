'use client';

import { CATALOG_SEARCH_MAX_LENGTH } from '@repo/shared';
import { Icon } from '@repo/ui';
import { Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCatalogSearch } from './use-catalog-search';

/**
 * The product search (MiniApp.dc.html `home`: 48 px, 14 px radius, search icon on the left and a
 * clear button on the right while it has text). It writes into the shared search state; the
 * catalog reads the debounced value from there.
 */
export function SearchBox({
  className,
  compact = false,
}: {
  className?: string;
  /** The 44 px field of the web header (smaller radius, input colours). */
  compact?: boolean;
}) {
  const t = useTranslations('store.catalog.search');
  const { text, setText, clear } = useCatalogSearch();
  return (
    <label className={`relative flex ${className ?? ''}`}>
      <span className="sr-only">{t('label')}</span>
      <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-foreground-muted">
        <Icon icon={Search} size={18} />
      </span>
      <input
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        maxLength={CATALOG_SEARCH_MAX_LENGTH}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={t('placeholder')}
        className={`min-w-0 flex-1 appearance-none border-[1.5px] px-11 text-[15px] font-semibold text-foreground outline-none transition duration-fast focus:border-ring focus:ring-3 focus:ring-primary-soft [&::-webkit-search-cancel-button]:hidden ${compact ? 'h-11 rounded-xl border-input-border bg-input' : 'h-12 rounded-[14px] border-border bg-card'}`}
      />
      {text === '' ? null : (
        <button
          type="button"
          aria-label={t('clear')}
          onClick={clear}
          className="absolute top-1.5 right-1.5 grid size-9 place-items-center rounded-[10px] bg-muted text-foreground-secondary transition duration-fast hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Icon icon={X} size={15} />
        </button>
      )}
    </label>
  );
}
