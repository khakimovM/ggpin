import type { ReactNode } from 'react';
import { TgTabBar, type TgTab } from './TgTabBar';

export interface AccountPageProps {
  variant: 'tg' | 'web';
  /** The Mini App's page title (the web screens draw their own heading next to their controls). */
  title?: string;
  /** Mini App only: the tab bar is drawn for the three root screens, and the page leaves room for it. */
  tab?: TgTab;
  children: ReactNode;
}

/**
 * The frame of the account screens. Mini App: a 640 px column inside Telegram's safe areas, with
 * the tab bar on the root screens. Web: the store's content width under the store header (the
 * header comes from the store layout).
 */
export function AccountPage({ variant, title, tab, children }: AccountPageProps) {
  if (variant === 'web') {
    return (
      <main className="mx-auto flex w-full max-w-[1264px] flex-1 flex-col gap-5 px-4 py-6 md:px-8 md:py-8">
        {children}
      </main>
    );
  }
  return (
    <>
      <main
        className={`mx-auto flex min-h-dvh w-full max-w-[640px] flex-col gap-4 bg-background px-4 pt-[max(16px,var(--tg-safe-top,0px))] text-foreground ${
          tab === undefined
            ? 'pb-[max(48px,var(--tg-safe-bottom,0px))]'
            : 'pb-[calc(112px+var(--tg-safe-bottom,0px))]'
        }`}
      >
        {title === undefined ? null : (
          <h1 className="m-0 text-[26px] leading-8 font-extrabold tracking-[-.02em]">{title}</h1>
        )}
        {children}
      </main>
      {tab === undefined ? null : <TgTabBar active={tab} />}
    </>
  );
}
