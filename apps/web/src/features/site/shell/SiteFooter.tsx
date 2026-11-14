import { BRAND, type Locale } from '@repo/shared';
import { cn, HIT_AREA_LINK, Icon, Logo } from '@repo/ui';
import { Bot, Megaphone } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { SiteLink } from './SiteLink';
import type { ReactNode } from 'react';
import { homePath, localizedPath } from '../../../i18n/paths';
import { yearInDisplayZone } from './current-year';
import { FOOTER_INFO_LINKS, FOOTER_PRODUCT_LINKS, linksToExistingPages } from './footer-links';
import { LINK_FOCUS } from './nav-config';
import { SiteLangSwitch } from './SiteLangSwitch';
import { siteLinks } from './site-links';

const LINK_CLASS = cn(
  'relative flex h-8 items-center gap-2 text-sm font-semibold text-foreground-secondary no-underline hover:text-foreground',
  HIT_AREA_LINK,
  LINK_FOCUS,
);

function Column({ title, children }: { title: string; children: ReactNode }) {
  return (
    // The links are 32 px high with a 2 px gap. On a touch screen their invisible pressable area
    // is 44 px (--hit-min), which would overlap the next link's by 10 px: there the gap grows to
    // the difference, so the areas touch and do not overlap. The drawn links keep their size.
    <nav aria-label={title} className="flex flex-col gap-[max(2px,calc(var(--hit-min,24px)-32px))]">
      <span className="mb-2 text-xs leading-4 font-bold tracking-[.06em] text-foreground-muted uppercase">
        {title}
      </span>
      {children}
    </nav>
  );
}

/**
 * Site.dc.html footer: the brand, the products, the information pages, Telegram, the copyright
 * and the language. The products and information columns list only pages that exist (the site
 * registry), so no link leads to a 404; a column with no page yet is not drawn at all. The
 * channel and the bot come from configuration and are left out when it is empty.
 */
export async function SiteFooter({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: 'site' });
  const links = siteLinks();
  const products = linksToExistingPages(FOOTER_PRODUCT_LINKS);
  const info = linksToExistingPages(FOOTER_INFO_LINKS);
  const langLabels = {
    group: t('nav.language'),
    names: { uz: t('nav.langUz'), ru: t('nav.langRu') },
  };

  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto flex w-full max-w-[1264px] flex-col gap-8 px-[clamp(16px,2.5vw,32px)] pt-[clamp(40px,4vw,56px)] pb-7">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] gap-x-8 gap-y-7">
          <div className="flex min-w-0 flex-col gap-3">
            <SiteLink
              href={homePath(locale)}
              className={cn(
                'relative flex w-fit items-center gap-2.5 text-foreground no-underline',
                HIT_AREA_LINK,
                LINK_FOCUS,
              )}
            >
              <Logo name={BRAND.name} size={32} decorative />
              <Logo name={BRAND.name} variant="wordmark" size={20} />
            </SiteLink>
            <span className="text-sm leading-[21px] font-medium text-foreground-muted">
              {t('footer.tagline')}
            </span>
          </div>
          {products.length === 0 ? null : (
            <Column title={t('footer.products')}>
              {products.map((link) => (
                <SiteLink
                  key={link.path}
                  href={localizedPath(locale, link.path)}
                  className={LINK_CLASS}
                >
                  {t(`footer.productLinks.${link.labelKey}`)}
                </SiteLink>
              ))}
            </Column>
          )}
          {info.length === 0 ? null : (
            <Column title={t('footer.info')}>
              {info.map((link) => (
                <SiteLink
                  key={link.path}
                  href={localizedPath(locale, link.path)}
                  className={LINK_CLASS}
                >
                  {t(`footer.infoLinks.${link.labelKey}`)}
                </SiteLink>
              ))}
            </Column>
          )}
          {links.channel === null && links.bot === null ? null : (
            <Column title={t('footer.telegram')}>
              {links.channel === null ? null : (
                <a
                  href={links.channel}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={LINK_CLASS}
                >
                  <Icon icon={Megaphone} size={15} />
                  {t('footer.channel')}
                </a>
              )}
              {links.bot === null ? null : (
                <a
                  href={links.bot}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={LINK_CLASS}
                >
                  <Icon icon={Bot} size={15} />
                  {links.botHandle}
                </a>
              )}
            </Column>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
          <span className="text-[13px] leading-[18px] font-semibold text-foreground-muted">
            {t('footer.copyright', { year: yearInDisplayZone(), brand: BRAND.name })}
          </span>
          <SiteLangSwitch labels={langLabels} />
        </div>
      </div>
    </footer>
  );
}
