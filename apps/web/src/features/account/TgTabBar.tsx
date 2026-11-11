'use client';

import { Icon, cn } from '@repo/ui';
import { CircleUser, History, House, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';

export type TgTab = 'home' | 'history' | 'profile';

const TABS: readonly { id: TgTab; href: string; icon: LucideIcon }[] = [
  { id: 'home', href: '/tg', icon: House },
  { id: 'history', href: '/tg/history', icon: History },
  { id: 'profile', href: '/tg/profile', icon: CircleUser },
];

/**
 * The bottom navigation of the Mini App (Account.dc.html `nav`): home, history, profile. The three
 * are the roots of the app, so moving between them replaces the entry instead of stacking one
 * (the native BackButton is hidden on all three and Telegram shows "Close").
 */
export function TgTabBar({ active }: { active: TgTab }) {
  const t = useTranslations('account.nav');
  return (
    <nav
      aria-label={t('main')}
      className="fixed inset-x-0 bottom-0 z-5 border-t border-border bg-[color-mix(in_oklab,var(--surface)_92%,transparent)] px-4 pt-2 pb-[max(12px,var(--tg-safe-bottom,0px))] backdrop-blur-md"
    >
      <div className="mx-auto grid max-w-[640px] grid-cols-3 gap-2">
        {TABS.map((tab) => {
          const current = tab.id === active;
          return (
            <Link
              key={tab.id}
              href={tab.href}
              replace
              aria-current={current ? 'page' : undefined}
              className={cn(
                'flex h-14 flex-col items-center justify-center gap-1 rounded-2xl text-[11px] leading-none font-extrabold no-underline focus-visible:outline-2 focus-visible:outline-ring',
                current
                  ? 'text-primary-soft-foreground hover:text-primary-soft-foreground'
                  : 'text-foreground-muted hover:text-foreground-muted',
              )}
            >
              <span
                className={cn(
                  'grid h-[30px] w-14 place-items-center rounded-full',
                  current && 'bg-primary-soft',
                )}
              >
                <Icon icon={tab.icon} size={19} />
              </span>
              {t(tab.id)}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
