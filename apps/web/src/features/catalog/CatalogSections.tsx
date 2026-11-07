'use client';

import type { CatalogSection } from './catalog-query';
import { ProductCard } from './ProductCard';
import { TelegramProductTile } from './TelegramProductTile';

export type CatalogVariant = 'tg' | 'web';

interface CatalogSectionsProps {
  variant: CatalogVariant;
  sections: readonly CatalogSection[];
  /** Section title for a section without a category (a search result, or unknown products). */
  fallbackTitle: string | null;
  productHref: (slug: string) => string;
}

const TELEGRAM_CATEGORY = 'telegram';

/**
 * The product sections. Mini App: one titled section per category, the Telegram one as two tall
 * tiles (MiniApp.dc.html `home`). Web: one flat grid (Store.dc.html `catalog`), its heading is
 * the page's own.
 */
export function CatalogSections({
  variant,
  sections,
  fallbackTitle,
  productHref,
}: CatalogSectionsProps) {
  const web = variant === 'web';
  const columns = web ? 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-4' : 'grid-cols-2 gap-3';

  return (
    <>
      {sections.map((section, index) => {
        const title = section.category?.name ?? fallbackTitle;
        const headingId = `catalog-section-${index}`;
        const tiles = !web && section.category?.slug === TELEGRAM_CATEGORY;
        return (
          <section
            key={section.category?.slug ?? `untitled-${index}`}
            aria-labelledby={title === null || web ? undefined : headingId}
            className="flex flex-col gap-3"
          >
            {title === null || web ? null : (
              <div className="flex items-baseline justify-between gap-2">
                <h2
                  id={headingId}
                  className="m-0 text-xl leading-[26px] font-extrabold tracking-[-.01em]"
                >
                  {title}
                </h2>
                <span className="text-[13px] leading-[18px] font-bold text-foreground-muted tabular-nums">
                  {section.items.length}
                </span>
              </div>
            )}
            <ul className={`m-0 grid list-none p-0 ${columns}`}>
              {section.items.map((product) => (
                <li key={product.id} className="flex">
                  <div className="flex-1">
                    {tiles ? (
                      <TelegramProductTile product={product} href={productHref(product.slug)} />
                    ) : (
                      <ProductCard
                        product={product}
                        href={productHref(product.slug)}
                        size={web ? 'roomy' : 'compact'}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
