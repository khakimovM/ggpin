import type { Locale } from '@repo/shared';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { pageMetadata } from '../seo/page-metadata';
import type { LegalDoc } from './legal-docs';
import { legalDescription } from './legal-texts';

/**
 * The metadata of a legal page: its title, and `noindex` while the document is a draft (D-57).
 * The description arrives with the published text. RULE (see page-metadata.ts): built from the
 * catalogs only, never from the network.
 */
export async function legalMetadata(locale: Locale, doc: LegalDoc): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: `site.meta.${doc.key}` });
  return pageMetadata({
    locale,
    path: doc.path,
    title: t('title'),
    description: doc.draft ? undefined : legalDescription(locale, doc.key),
    noindex: doc.draft,
  });
}
