import type { Locale } from '@repo/shared';
import { MESSAGES } from '../../../i18n/messages';
import type { LegalDocKey, PublishedLegalDoc } from './legal-docs';

// The lawyer's texts are read from the catalogs as data, not through typed `t()` keys: while a
// document is a draft its keys do not exist yet, and a legal text must come out exactly as it was
// written (no ICU reading of its braces or apostrophes).

export interface LegalSection {
  /** The id from `sectionIds`; the anchor of the section is `section-<id>`. */
  id: string;
  /** 1, 2, 3...: the order of `sectionIds`. */
  number: number;
  title: string;
  /** The body split at blank lines. */
  paragraphs: string[];
}

function textAt(root: unknown, path: readonly string[]): string | undefined {
  let node: unknown = root;
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === 'string' && node.trim() !== '' ? node : undefined;
}

/**
 * The numbered sections of a published document in a language. A section without its title or
 * its body throws: half a contract is never rendered (the unit test finds it before a build).
 */
export function legalSections(
  locale: Locale,
  doc: PublishedLegalDoc,
  catalog: unknown = MESSAGES[locale],
): LegalSection[] {
  return doc.sectionIds.map((id, index) => {
    const at = ['legal', doc.key, 'sections', id];
    const title = textAt(catalog, [...at, 'title']);
    const body = textAt(catalog, [...at, 'body']);
    if (title === undefined || body === undefined) {
      throw new Error(`legal text missing: ${locale}:legal.${doc.key}.sections.${id}`);
    }
    const paragraphs = body
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph !== '');
    return { id, number: index + 1, title, paragraphs };
  });
}

/** `site.meta.<doc>.description`, written with the published text; none while it is a draft. */
export function legalDescription(
  locale: Locale,
  key: LegalDocKey,
  catalog: unknown = MESSAGES[locale],
): string | undefined {
  return textAt(catalog, ['site', 'meta', key, 'description']);
}
