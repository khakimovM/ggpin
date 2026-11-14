import type { Locale } from '@repo/shared';
import type { LegalDoc } from './legal-docs';
import { LegalDocument } from './LegalDocument';
import { LegalDraft } from './LegalDraft';

/**
 * The page of a legal text (`/terms`, `/privacy`): the "being prepared" page while the document is
 * a draft, the numbered document once the lawyer's text is published (see legal-docs.ts).
 */
export function LegalPage({ locale, doc }: { locale: Locale; doc: LegalDoc }) {
  return doc.draft ? (
    <LegalDraft locale={locale} docKey={doc.key} />
  ) : (
    <LegalDocument locale={locale} doc={doc} />
  );
}
