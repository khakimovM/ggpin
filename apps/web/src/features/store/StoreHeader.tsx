'use client';

import { BRAND } from '@repo/shared';
import { HIT_AREA_LINK, Logo } from '@repo/ui';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { stripLocale } from '../../i18n/locale-path';
import { localizedPath } from '../../i18n/paths';
import { SearchBox } from '../catalog/SearchBox';
import { AccountMenu } from './AccountMenu';
import { LanguageSwitch } from './LanguageSwitch';
import { ThemeToggle } from './ThemeToggle';
import { useSearchUrlSync } from './use-search-url-sync';
import { WalletPill } from './WalletPill';

const NAV = [
  { path: '/store', key: 'catalog' },
  { path: '/store/orders', key: 'orders' },
  { path: '/store/profile', key: 'profile' },
] as const;

/**
 * Store.dc.html header: logo, the three screens (catalog, history, profile) from 768 px, the balance
 * and the account menu. The search is inline from 1024 px and on its own row below it (the
 * design's tablet frame); the language and the theme are in the header from 1024 px and in the
 * account menu below it. It sits behind AuthGuard, so the profile and the wallet can be read.
 */
export function StoreHeader() {
  const t = useTranslations('web.nav');
  const login = useTranslations('web.login');
  const locale = useLocale();
  const pathname = stripLocale(usePathname());
  useSearchUrlSync();

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-surface">
      <div className="mx-auto flex h-[72px] w-full max-w-[1264px] items-center gap-3 px-4 md:px-6 lg:gap-5 lg:px-8">
        <Link
          href={localizedPath(locale, '/store')}
          aria-label={login('homeLabel', { brand: BRAND.name })}
          className={`relative flex shrink-0 items-center gap-2.5 text-foreground no-underline ${HIT_AREA_LINK}`}
        >
          {/* The mark is decorative: the link's name starts with the visible wordmark (WCAG 2.5.3). */}
          <Logo name={BRAND.name} size={34} decorative />
          <Logo name={BRAND.name} variant="wordmark" size={20} className="hidden sm:inline-block" />
        </Link>
        <nav aria-label={t('main')} className="hidden shrink-0 gap-0.5 md:flex">
          {NAV.map((item) => {
            const current =
              item.path === '/store' ? pathname === item.path : pathname.startsWith(item.path);
            return (
              <Link
                key={item.path}
                href={localizedPath(locale, item.path)}
                aria-current={current ? 'page' : undefined}
                className={`relative flex h-10 items-center rounded-[10px] px-3.5 text-sm font-extrabold whitespace-nowrap no-underline hover:bg-muted ${HIT_AREA_LINK} ${current ? 'bg-primary-soft text-primary-soft-foreground' : 'text-foreground-secondary'}`}
              >
                {t(item.key)}
              </Link>
            );
          })}
        </nav>
        <SearchBox compact className="hidden max-w-[420px] min-w-40 flex-1 lg:flex" />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <WalletPill />
          <LanguageSwitch className="hidden lg:inline-flex" />
          <ThemeToggle className="hidden lg:grid" />
          <AccountMenu />
        </div>
      </div>
      <div className="px-4 pb-3 md:px-6 lg:hidden">
        <SearchBox compact />
      </div>
    </header>
  );
}
