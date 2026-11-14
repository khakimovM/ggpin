import type { Locale } from '@repo/shared';
import { requestNonce } from '../../../csp/request-nonce';
import { env } from '../../../env';
import { localizedPath } from '../../../i18n/paths';
import { getTranslations } from 'next-intl/server';
import { JsonLd } from '../seo/JsonLd';
import { breadcrumbLd, faqLd } from '../seo/json-ld';
import { pageUrl } from '../seo/page-metadata';
import { Breadcrumbs, type Crumb } from './Breadcrumbs';
import { HowToBuy } from './HowToBuy';
import { ProductFaq } from './ProductFaq';
import { ProductHero } from './ProductHero';
import { RelatedProducts } from './RelatedProducts';
import { getProductFaq } from './product-faq';
import type { SeoProduct } from './seo-products';

/**
 * A product's page for search and for people who arrive from it (Site.dc.html `page: product`):
 * the breadcrumb, the hero with the facts and the package list, how to buy, the questions, and the
 * other products. A server component all the way; its one client island is the package list.
 * Everything that needs the catalog is inside a <Suspense> of its own (see ProductHero and
 * RelatedProducts), so the page is never held up by a slow API; the structured data (the
 * breadcrumb and the questions) and the metadata need no catalog at all.
 */
export async function ProductSeoPage({ locale, seo }: { locale: Locale; seo: SeoProduct }) {
  const [t, names, nonce, faq] = await Promise.all([
    getTranslations({ locale, namespace: 'site.product.common.breadcrumb' }),
    getTranslations({ locale, namespace: 'site.products.names' }),
    requestNonce(),
    getProductFaq(locale, seo),
  ]);
  const home = localizedPath(locale, '/');
  const name = names(seo.nameKey);
  // The home path is '/' or '/ru': the fragment follows it as it is (a '/ru/' would cost a redirect).
  const productsHref = `${home}#products`;
  const crumbs: Crumb[] = [
    { label: t('home'), href: home },
    { label: t('products'), href: productsHref },
    { label: name, href: null },
  ];
  const site = env.NEXT_PUBLIC_SITE_URL;
  const homeUrl = pageUrl(site, locale, '/');

  return (
    <main>
      <JsonLd
        nonce={nonce}
        data={breadcrumbLd([
          { name: t('home'), url: homeUrl },
          // No "Mahsulotlar" item: it would be `/#products`, and search engines count a fragment as
          // the same page, so the trail is home and the product. The visible trail keeps the link.
          { name, url: pageUrl(site, locale, seo.path) },
        ])}
      />
      <JsonLd nonce={nonce} data={faqLd(faq)} />
      <Breadcrumbs label={t('label')} items={crumbs} />
      <ProductHero locale={locale} seo={seo} />
      <HowToBuy locale={locale} seo={seo} />
      <ProductFaq locale={locale} seo={seo} items={faq} />
      <RelatedProducts locale={locale} exclude={seo.slug} />
    </main>
  );
}
