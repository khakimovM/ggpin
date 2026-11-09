'use client';

import { Avatar, Icon } from '@repo/ui';
import { ChevronDown, CircleUser, History, LogOut } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { localizedPath } from '../../i18n/paths';
import { useLogout } from '../auth/use-logout';
import { useMe } from '../auth/use-me';
import { LanguageSwitch } from './LanguageSwitch';
import { ThemeToggle } from './ThemeToggle';

const ITEM =
  'flex h-11 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-sm font-bold text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring';

/**
 * Store.dc.html's account menu: the avatar with a chevron opens a panel with the profile, (on
 * narrow screens) the language and theme, and the sign-out. Escape or a click outside closes it
 * and Escape hands the focus back to the button. A plain disclosure, not an ARIA menu: it holds
 * links and controls the user tabs through.
 */
export function AccountMenu() {
  const t = useTranslations('web.nav');
  const logoutLabel = useTranslations('web.logout')('action');
  const locale = useLocale();
  const me = useMe();
  const logout = useLogout();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const name = me.data?.firstName ?? me.data?.username ?? undefined;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (root.current && event.target instanceof Node && !root.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div
      ref={root}
      className="relative"
      // Keyboard: Tab out of the menu closes it. Focus moving to somewhere inside it, or to nothing
      // (a click on a part that cannot take focus), leaves it open; a click outside is the pointer
      // handler's.
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (open && next instanceof Node && !event.currentTarget.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        aria-label={t('menu')}
        aria-expanded={open}
        aria-controls="account-menu"
        onClick={() => setOpen((value) => !value)}
        className="flex h-11 items-center gap-1 rounded-full border-[1.5px] border-border bg-card py-0 pr-1.5 pl-1 text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Avatar name={name} src={me.data?.photoUrl ?? undefined} size={32} />
        <Icon icon={ChevronDown} size={15} className="text-foreground-muted" />
      </button>
      {open ? (
        <div
          id="account-menu"
          className="absolute top-[52px] right-0 z-40 flex w-[260px] flex-col gap-0.5 rounded-[18px] border border-border bg-elevated p-2 shadow-lg"
        >
          <div className="mb-1 flex items-center gap-2.5 border-b border-border px-2.5 pt-2 pb-3">
            <Avatar name={name} src={me.data?.photoUrl ?? undefined} size={40} />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-sm leading-[18px] font-extrabold">{name}</span>
              {me.data?.username ? (
                <span className="truncate text-xs leading-4 font-semibold text-foreground-muted">
                  @{me.data.username}
                </span>
              ) : null}
            </span>
          </div>
          <Link
            href={localizedPath(locale, '/store/orders')}
            className={ITEM}
            onClick={() => setOpen(false)}
          >
            <Icon icon={History} size={17} className="text-foreground-muted" />
            {t('orders')}
          </Link>
          <Link
            href={localizedPath(locale, '/store/profile')}
            className={ITEM}
            onClick={() => setOpen(false)}
          >
            <Icon icon={CircleUser} size={17} className="text-foreground-muted" />
            {t('profile')}
          </Link>
          <div className="flex items-center justify-between gap-2 px-2.5 py-1 lg:hidden">
            <LanguageSwitch />
            <ThemeToggle />
          </div>
          <button
            type="button"
            className={`${ITEM} text-danger-text hover:bg-danger-soft`}
            onClick={() => logout.mutate()}
          >
            <Icon icon={LogOut} size={17} />
            {logoutLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}
