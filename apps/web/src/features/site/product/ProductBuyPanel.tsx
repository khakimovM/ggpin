import type { Locale } from '@repo/shared';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { storePath } from '../../../i18n/paths';
import { landingPriceAmount } from '../landing/landing-products';
import { siteLinks } from '../shell/site-links';
import { PackagePicker, type PackageOption } from './PackagePicker';
import { BuyDisabled, BuyLink, TelegramButton } from './ProductButtons';
import { loadProduct } from './product-data';
import { PRODUCT_BUTTONS } from './product-styles';
import { pickerNotes } from './product-texts';
import { buildProductView } from './product-view';
import type { SeoProduct } from './seo-products';

const CARD =
  'flex flex-col gap-1.5 rounded-3xl border border-border bg-card p-5 text-[15px] leading-[22px] font-medium text-foreground-secondary';

function Note({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className={CARD}>
      {title === undefined ? null : (
        <p className="m-0 text-lg leading-6 font-extrabold text-foreground">{title}</p>
      )}
      <p className="m-0 text-pretty">{children}</p>
    </div>
  );
}

/**
 * The right column under the lead: the package list with the buy button, or what stands in its
 * place when there is nothing to list. The four states of the page (phase 8 plan, P8-Q20):
 *  - filled: the packages with the server's prices; the buy button carries the chosen one's price;
 *  - no packages: the minimum and a note, the buy button still leads into the store;
 *  - catalog unavailable: no price anywhere, a note, the buy button stays;
 *  - the product does not exist: "Hozircha mavjud emas", the buy button is disabled (HTTP is 200).
 * Nothing is computed here: every amount is a tiyin string of the server, laid out by `formatMoney`.
 */
export async function ProductBuyPanel({ locale, seo }: { locale: Locale; seo: SeoProduct }) {
  const [t, copy, money, lookup] = await Promise.all([
    getTranslations({ locale, namespace: 'site.product.common' }),
    getTranslations({ locale, namespace: `site.product.${seo.contentKey}` }),
    getTranslations({ locale, namespace: 'common.money' }),
    loadProduct(seo.slug, locale),
  ]);
  const view = buildProductView(lookup, seo);
  // A bot-less configuration has no link: the button is then left out, not left dead.
  const telegram = <TelegramButton href={siteLinks().bot} label={t('telegram')} />;
  // Not a SEO page: the store's page of the product (the sign-in guard sits in front of it).
  const buyHref = `${storePath(locale)}/products/${seo.slug}`;
  // A typed amount (and the unit it is counted in) is a thing of the products whose page lists a
  // minimum; the texts about it live in that product's own namespace.
  const typedQty = view.customQty && view.minQty !== null && seo.facts.includes('min');

  if (view.state === 'not-found') {
    return (
      <>
        <Note title={t('unavailable.title')}>{t('unavailable.body')}</Note>
        <div className={PRODUCT_BUTTONS}>
          <BuyDisabled label={t('buy.label')} />
          {telegram}
        </div>
      </>
    );
  }

  if (view.state === 'ok') {
    const options = view.packages.map((item): PackageOption => {
      const amount = landingPriceAmount(item.priceTiyin, locale);
      const price = amount === null ? null : money('uzs', { amount });
      return {
        id: item.id,
        label: item.label,
        price,
        cta: price === null ? t('buy.label') : t('buy.withPrice', { price }),
      };
    });
    const notes = await pickerNotes(locale, seo, {
      typedMin: typedQty ? view.minQty : null,
      priced: options.some((option) => option.price !== null),
    });

    return (
      <PackagePicker
        label={copy('packages.label')}
        amountHeading={copy('packages.amount')}
        priceHeading={t('packages.price')}
        options={options}
        notes={notes}
        buyHref={buyHref}
      >
        {telegram}
      </PackagePicker>
    );
  }

  // No packages to list, or the catalog could not be read: say what is known and lead into the store.
  const note =
    view.state === 'unavailable'
      ? t('packages.noPrices')
      : typedQty && view.minQty !== null
        ? copy('packages.noPackagesMin', { min: view.minQty })
        : t('packages.noPackages');
  return (
    <>
      <Note>{note}</Note>
      <div className={PRODUCT_BUTTONS}>
        <BuyLink href={buyHref} label={t('buy.label')} />
        {telegram}
      </div>
    </>
  );
}
