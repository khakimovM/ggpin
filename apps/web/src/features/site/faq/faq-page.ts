import { BRAND, type Locale } from '@repo/shared';
import { getTranslations } from 'next-intl/server';
import type { LandingFaqId } from '../landing/faq-items';
import type { FaqItem } from './FaqAccordion';

// The questions of the FAQ page (P8-Q9): the landing's five (`site.faq.items`) and the help
// screen's six (`account.help.faq`), each question asked once. Only texts the owner has already
// approved are used, so the page makes no new promise. Where the two ask the same thing, the
// landing's wording is kept: it is the newer text, written for the website.

export const HELP_FAQ_IDS = ['1', '2', '3', '4', '5', '6'] as const;
export type HelpFaqId = (typeof HELP_FAQ_IDS)[number];

export type FaqSource = { from: 'landing'; id: LandingFaqId } | { from: 'help'; id: HelpFaqId };

/** The help questions the landing already asks, and the landing question that answers each. */
export const HELP_ASKED_ON_LANDING: Readonly<Partial<Record<HelpFaqId, LandingFaqId>>> = {
  // "How fast is an order delivered?"
  '1': '1',
  // "What if I typed the username (or the ID) wrong?"
  '2': '2',
  // "What happens to my money if the order fails?"
  '3': '3',
};

/** The order on the page: the order itself, then the money, then the extras. */
export const FAQ_PAGE: readonly FaqSource[] = [
  { from: 'landing', id: '1' },
  { from: 'landing', id: '2' },
  { from: 'landing', id: '3' },
  { from: 'landing', id: '4' },
  // How to top the wallet up, and whether its money can be taken back out.
  { from: 'help', id: '4' },
  { from: 'help', id: '6' },
  { from: 'landing', id: '5' },
  // The cashback coins.
  { from: 'help', id: '5' },
];

/** The page's questions and answers in a language; the accordion and the FAQPage JSON-LD share them. */
export async function getFaqPageItems(locale: Locale): Promise<FaqItem[]> {
  const [landing, help] = await Promise.all([
    getTranslations({ locale, namespace: 'site.faq.items' }),
    getTranslations({ locale, namespace: 'account.help.faq' }),
  ]);
  return FAQ_PAGE.map((source) =>
    source.from === 'landing'
      ? { question: landing(`q${source.id}`), answer: landing(`a${source.id}`) }
      : {
          question: help(`q${source.id}`),
          // One help answer (a6, the wallet is for purchases only) names the brand.
          answer: help(`a${source.id}`, { brand: BRAND.name }),
        },
  );
}
