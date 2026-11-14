import { BRAND, type Locale } from '@repo/shared';
import { cn, HIT_AREA_LINK, Icon, Logo } from '@repo/ui';
import { Send } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { SiteLink } from './SiteLink';
import { homePath, loginPath } from '../../../i18n/paths';
import { NAV_ITEMS, NAV_LAYOUT, LINK_FOCUS } from './nav-config';
import { SiteLangSwitch } from './SiteLangSwitch';
import { SiteMobileMenu } from './SiteMobileMenu';
import { siteLinks } from './site-links';

/**
 * Site.dc.html header: the logo, the three sections, the language, "Kirish" and "Open in
 * Telegram". Below the breakpoint of the language (see NAV_LAYOUT) the sections, the language and
 * the Telegram button move into the mobile menu. A server component: only the menu is a client
 * island.
 */
export async function SiteHeader({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: 'site.nav' });
  const links = siteLinks();
  const layout = NAV_LAYOUT[locale];
  // Sections are on the landing: from any other page the link goes home to the section.
  const items = NAV_ITEMS.map((item) => ({
    href: `${homePath(locale)}#${item.id}`,
    label: t(item.labelKey),
  }));
  const login = { href: loginPath(locale), label: t('login') };
  const telegram = links.bot === null ? null : { href: links.bot, label: t('openTelegram') };
  const langLabels = { group: t('language'), names: { uz: t('langUz'), ru: t('langRu') } };

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/86 backdrop-blur-[14px]">
      <div className="mx-auto flex h-[clamp(64px,5vw,72px)] w-full max-w-[1264px] items-center gap-8 px-[clamp(16px,2.5vw,32px)]">
        <SiteLink
          href={homePath(locale)}
          aria-label={t('home', { brand: BRAND.name })}
          className={cn(
            'relative flex shrink-0 items-center gap-2.5 text-foreground no-underline',
            HIT_AREA_LINK,
            LINK_FOCUS,
          )}
        >
          {/* Both parts are decorative: the link's name starts with the wordmark (WCAG 2.5.3). */}
          <Logo name={BRAND.name} size={32} decorative />
          <Logo name={BRAND.name} variant="wordmark" size={20} decorative />
        </SiteLink>
        <nav aria-label={t('main')} className={cn('gap-0', layout.wide)}>
          {items.map((item) => (
            <SiteLink
              key={item.href}
              href={item.href}
              className={cn(
                'relative flex h-10 items-center rounded-sm px-3.5 text-sm font-bold whitespace-nowrap text-foreground-secondary no-underline hover:bg-muted hover:text-foreground',
                HIT_AREA_LINK,
                LINK_FOCUS,
              )}
            >
              {item.label}
            </SiteLink>
          ))}
        </nav>
        <div className={cn('ml-auto items-center gap-2', layout.wide)}>
          <SiteLangSwitch labels={langLabels} />
          <SiteLink
            href={login.href}
            prefetch={false}
            className={cn(
              'relative flex h-11 items-center rounded-control px-4 text-sm font-bold whitespace-nowrap text-foreground no-underline hover:bg-muted',
              LINK_FOCUS,
            )}
          >
            {login.label}
          </SiteLink>
          {telegram === null ? null : (
            <a
              href={telegram.href}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                // Not buttonVariants(): it lives in a client module and cannot be called on the server.
                'flex h-11 shrink-0 items-center justify-center gap-2 rounded-control bg-primary px-[18px] text-sm font-bold whitespace-nowrap text-primary-foreground no-underline transition-colors duration-fast hover:bg-primary-hover active:bg-primary-pressed active:scale-[.97]',
                LINK_FOCUS,
              )}
            >
              <Icon icon={Send} size={16} />
              {telegram.label}
            </a>
          )}
        </div>
        <SiteMobileMenu
          className={layout.narrow}
          menuLabel={t('menu')}
          items={items}
          login={login}
          telegram={telegram}
          languageLabel={t('language')}
          langSwitch={<SiteLangSwitch labels={langLabels} size="menu" />}
        />
      </div>
    </header>
  );
}
