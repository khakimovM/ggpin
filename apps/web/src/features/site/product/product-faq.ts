import type { Locale } from '@repo/shared';
import { getTranslations } from 'next-intl/server';
import type { FaqItem } from '../faq/FaqAccordion';
import type { SeoProduct } from './seo-products';

/**
 * The questions of a product page in a language. The answers come only from texts the owner has
 * approved (the product design, the landing FAQ, `account.help.faq`): no new promise is made. The
 * section and the page's FAQPage JSON-LD share them.
 */
export async function getProductFaq(locale: Locale, seo: SeoProduct): Promise<FaqItem[]> {
  const t = await getTranslations({
    locale,
    namespace: `site.product.${seo.contentKey}.faq.items`,
  });
  const ids = ['1', '2', '3', '4'] as const;
  return ids.slice(0, seo.faqCount).map((id) => ({ question: t(`q${id}`), answer: t(`a${id}`) }));
}
