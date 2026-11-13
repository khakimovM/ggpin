import type { Locale } from '@repo/shared';
import { Button, Icon } from '@repo/ui';
import { FileText } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { localizedPath } from '../../../i18n/paths';
import type { LegalDocKey } from './legal-docs';

/**
 * A legal page while its document is a draft (D-57): the document's name, one sentence saying it
 * is being prepared, and the way to the contacts. Nothing else, and no legal wording of any kind.
 * The look of the system pages (Site.dc.html `page: 404` / `page: error`): a tinted circle with an
 * icon, the heading, the sentence, one button.
 */
export async function LegalDraft({ locale, docKey }: { locale: Locale; docKey: LegalDocKey }) {
  const [meta, t] = await Promise.all([
    getTranslations({ locale, namespace: `site.meta.${docKey}` }),
    getTranslations({ locale, namespace: 'legal' }),
  ]);

  return (
    <main className="grid min-h-[clamp(560px,46vw,680px)] place-items-center px-4 py-[clamp(40px,6vw,80px)]">
      <div className="flex max-w-[480px] flex-col items-center gap-4 text-center">
        <span
          aria-hidden="true"
          className="grid size-20 place-items-center rounded-full bg-info-soft text-info"
        >
          <Icon icon={FileText} size={36} />
        </span>
        <h1 className="m-0 text-2xl leading-[1.2] font-extrabold tracking-[-.02em] text-balance md:text-[32px]">
          {meta('title')}
        </h1>
        <p className="m-0 text-base leading-6 font-medium text-pretty text-foreground-secondary">
          {t('draftNotice')}
        </p>
        <Button asChild size="lg" className="mt-2">
          <Link href={localizedPath(locale, '/contacts')} prefetch={false}>
            {t('contact')}
          </Link>
        </Button>
      </div>
    </main>
  );
}
