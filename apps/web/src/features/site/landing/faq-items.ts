import type { Locale } from '@repo/shared';
import { getTranslations } from 'next-intl/server';
import type { FaqItem } from '../faq/FaqAccordion';

// The questions of the landing's FAQ, in the order they are shown. The answers come only from
// texts the owner has approved (the landing design and `account.help.faq`): no new promise is
// made here.
export const LANDING_FAQ_IDS = ['1', '2', '3', '4', '5'] as const;
export type LandingFaqId = (typeof LANDING_FAQ_IDS)[number];

/**
 * The landing's questions and answers in a language, for its FAQ section. Their `FAQPage` JSON-LD is
 * on `/faq` only, which asks them too.
 */
export async function getLandingFaq(locale: Locale): Promise<FaqItem[]> {
  const t = await getTranslations({ locale, namespace: 'site.faq.items' });
  return LANDING_FAQ_IDS.map((id) => ({ question: t(`q${id}`), answer: t(`a${id}`) }));
}
