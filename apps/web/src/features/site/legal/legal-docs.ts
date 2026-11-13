// The legal texts of the website: the public offer (`/terms`) and the privacy policy (`/privacy`).
//
// Until the lawyer's text exists (D-16) a document is a DRAFT: its page says only that the document
// is being prepared and links to the contacts, it carries `noindex` and it is not in the sitemap
// (D-57). No stand-in legal wording is ever written in its place.
//
// Publishing one (phase 8 S4-b) is a data change in three places. The tests in
// `__tests__/legal-docs.test.ts` check each document by its own `draft` flag: they pass for a
// draft and for a published document alike, and fail only while the three places disagree (text
// in the catalogs of a draft, a published entry without its text, description or a real
// `updatedAt` day, or a registry page whose `indexable` does not follow the flag):
//  1. the text goes into both catalogs: `legal.<doc>.sections.<id>.title` and `.body` (paragraphs
//     separated by a blank line), and `site.meta.<doc>.description`;
//  2. the entry below becomes `{ draft: false, updatedAt: 'YYYY-MM-DD', sectionIds: [...] }`;
//  3. its page in `seo/site-pages.ts` becomes `indexable: true`.

export type LegalDocKey = 'terms' | 'privacy';

interface LegalDocBase {
  key: LegalDocKey;
  /** The page without a locale prefix; the same English slug in both languages (D-57). */
  path: `/${LegalDocKey}`;
}

export interface DraftLegalDoc extends LegalDocBase {
  draft: true;
  updatedAt: null;
}

export interface PublishedLegalDoc extends LegalDocBase {
  draft: false;
  /** The day the text takes effect (YYYY-MM-DD), shown as "Kuchga kirgan sana". */
  updatedAt: string;
  /** The sections in the order they are numbered; ids are `[a-z0-9-]` (they become anchors). */
  sectionIds: readonly [string, ...string[]];
}

export type LegalDoc = DraftLegalDoc | PublishedLegalDoc;

const DOCS: Record<LegalDocKey, LegalDoc> = {
  terms: { key: 'terms', path: '/terms', draft: true, updatedAt: null },
  privacy: { key: 'privacy', path: '/privacy', draft: true, updatedAt: null },
};

export const LEGAL_DOC_KEYS = ['terms', 'privacy'] as const satisfies readonly LegalDocKey[];

export function legalDoc(key: LegalDocKey): LegalDoc {
  return DOCS[key];
}

export const LEGAL_DOCS: readonly LegalDoc[] = LEGAL_DOC_KEYS.map(legalDoc);
