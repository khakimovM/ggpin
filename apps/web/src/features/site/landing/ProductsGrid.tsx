import type { Locale } from '@repo/shared';
import { cn, Icon } from '@repo/ui';
import { Send } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { localizedPath } from '../../../i18n/paths';
import { getSiteProducts } from '../catalog-server';
import { siteLinks } from '../shell/site-links';
import { buildLandingProducts, landingPriceAmount, type LandingTile } from './landing-products';
import { LANDING_CTA_SECONDARY, PRODUCT_GRID } from './landing-styles';
import { SiteProductCard } from './SiteProductCard';

/**
 * The products block: it reads the catalog on the server (the one slow thing on the page, hence
 * the <Suspense> around it) and draws one of four things: the live tiles with "Tez orada" after
 * them; the same without prices when the API cannot be used (no banner: the page stays a healthy
 * document for a crawler, and a visitor still reaches the store); only "Tez orada" with a way into
 * the bot when the catalog is empty. The loading state is `ProductsSkeleton`.
 */
export async function ProductsGrid({ locale }: { locale: Locale }) {
  const [t, catalog, money, cta] = await Promise.all([
    getTranslations({ locale, namespace: 'site.products' }),
    getTranslations({ locale, namespace: 'store.catalog' }),
    getTranslations({ locale, namespace: 'common.money' }),
    getTranslations({ locale, namespace: 'site.cta' }),
  ]);
  const view = buildLandingProducts(await getSiteProducts(locale));
  const links = siteLinks();

  const labels = {
    popular: catalog('badge.popular'),
    auto: catalog('badge.auto'),
    code: catalog('badge.code'),
    soldOut: catalog('soldOut'),
    soon: t('soon'),
    soonNote: t('soonNote'),
  };
  const nameOf = (tile: LandingTile): string =>
    tile.name ?? (tile.nameKey === null ? tile.slug : t(`names.${tile.nameKey}`));
  const priceOf = (tile: LandingTile) => {
    const amount = landingPriceAmount(tile.fromPriceTiyin, locale);
    if (amount === null) return null;
    return t.rich('fromPrice', {
      price: money('uzs', { amount }),
      muted: (chunks) => (
        <span className="text-xs leading-4 font-medium text-foreground-muted">{chunks}</span>
      ),
    });
  };

  return (
    <>
      <ul className={PRODUCT_GRID} data-state={view.state}>
        {view.tiles.map((tile) => (
          <SiteProductCard
            key={tile.slug}
            tile={tile}
            name={nameOf(tile)}
            href={tile.path === null ? null : localizedPath(locale, tile.path)}
            price={priceOf(tile)}
            labels={labels}
          />
        ))}
      </ul>
      {view.state === 'empty' ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <p className="m-0 text-base leading-6 font-semibold text-foreground-secondary">
            {t('empty')}
          </p>
          {links.bot === null ? null : (
            <a
              href={links.bot}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(LANDING_CTA_SECONDARY, 'w-full max-w-[280px] sm:w-auto')}
            >
              <Icon icon={Send} size={18} />
              {cta('telegram')}
            </a>
          )}
        </div>
      ) : null}
    </>
  );
}
