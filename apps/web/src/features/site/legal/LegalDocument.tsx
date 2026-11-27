import type { Locale } from '@repo/shared';
import { cn, HIT_AREA_LINK } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { requestNonce } from '../../../csp/request-nonce';
import { env } from '../../../env';
import { localizedPath } from '../../../i18n/paths';
import { formatFullDay } from '../../../lib/format/date';
import { LANDING_ANCHOR, LANDING_CONTAINER, LANDING_H2 } from '../landing/landing-styles';
import { Breadcrumbs } from '../product/Breadcrumbs';
import { JsonLd } from '../seo/JsonLd';
import { breadcrumbLd } from '../seo/json-ld';
import { pageUrl } from '../seo/page-metadata';
import { LINK_FOCUS } from '../shell/nav-config';
import type { PublishedLegalDoc } from './legal-docs';
import { legalSections, type LegalSection } from './legal-texts';

const TOC_LINK = cn(
  'relative inline-flex gap-2 text-[15px] leading-5 font-semibold text-foreground-secondary no-underline hover:text-foreground',
  HIT_AREA_LINK,
  LINK_FOCUS,
);

// `updatedAt` is a calendar day, not an instant: it is read and shown in UTC so that no time zone
// can move it to the day before or after.
const effectiveDay = (iso: string, locale: Locale) =>
  formatFullDay(new Date(`${iso}T00:00:00Z`), { locale, timeZone: 'UTC' });

function Section({ section }: { section: LegalSection }) {
  const id = `section-${section.id}`;
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn(LANDING_ANCHOR, 'flex flex-col gap-3')}
    >
      <h2 id={`${id}-title`} className="m-0 text-xl leading-7 font-extrabold tracking-[-.01em]">
        {section.number}. {section.title}
      </h2>
      {section.paragraphs.map((paragraph, index) => (
        <p
          key={`${id}-${String(index)}`}
          className="m-0 text-base leading-[26px] font-medium text-foreground-secondary"
        >
          {paragraph}
        </p>
      ))}
    </section>
  );
}

/**
 * A published legal text (the template the lawyer's text drops into, phase 8 S4-b): the trail, the
 * title with the day it takes effect, the table of contents, and the numbered sections. Landing
 * type sizes in a reading column; the sections come from the catalogs (`legal-texts.ts`).
 */
export async function LegalDocument({ locale, doc }: { locale: Locale; doc: PublishedLegalDoc }) {
  const [crumbs, meta, t, nonce] = await Promise.all([
    getTranslations({ locale, namespace: 'site.product.common.breadcrumb' }),
    getTranslations({ locale, namespace: `site.meta.${doc.key}` }),
    getTranslations({ locale, namespace: 'legal' }),
    requestNonce(),
  ]);
  const sections = legalSections(locale, doc);
  const title = meta('title');
  const site = env.NEXT_PUBLIC_SITE_URL;

  return (
    <main>
      <JsonLd
        nonce={nonce}
        data={breadcrumbLd([
          { name: crumbs('home'), url: pageUrl(site, locale, '/') },
          { name: title, url: pageUrl(site, locale, doc.path) },
        ])}
      />
      <Breadcrumbs
        label={crumbs('label')}
        items={[
          { label: crumbs('home'), href: localizedPath(locale, '/') },
          { label: title, href: null },
        ]}
      />
      <article
        className={cn(LANDING_CONTAINER, 'pt-[clamp(20px,3vw,40px)] pb-[clamp(48px,6vw,88px)]')}
      >
        <div className="mx-auto flex max-w-[760px] flex-col gap-8">
          <header className="flex flex-col gap-3">
            <h1 className={LANDING_H2}>{title}</h1>
            <p className="m-0 text-sm leading-5 font-semibold text-foreground-muted">
              {t('updated', { date: effectiveDay(doc.updatedAt, locale) })}
            </p>
          </header>
          <nav aria-labelledby="legal-toc" className="rounded-3xl border border-border bg-card p-6">
            <h2
              id="legal-toc"
              className="m-0 text-xs leading-4 font-bold tracking-[.06em] text-foreground-muted uppercase"
            >
              {t('toc')}
            </h2>
            {/* On a touch screen a link's pressable area is 44 px: the gap keeps two rows apart. */}
            <ol className="m-0 mt-4 flex list-none flex-col gap-[max(6px,calc(var(--hit-min,24px)-20px))] p-0">
              {sections.map((section) => (
                <li key={section.id} className="flex">
                  <a href={`#section-${section.id}`} className={TOC_LINK}>
                    {/* The space is not drawn in a flex row; it keeps the name "1. Title". */}
                    <span className="tabular-nums">{section.number}.</span>{' '}
                    <span>{section.title}</span>
                  </a>
                </li>
              ))}
            </ol>
          </nav>
          {sections.map((section) => (
            <Section key={section.id} section={section} />
          ))}
        </div>
      </article>
    </main>
  );
}
