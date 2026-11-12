'use client';

import { cn, HIT_AREA_LINK, Icon } from '@repo/ui';
import { ChevronRight, Menu, Send, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { LINK_FOCUS } from './nav-config';

export interface MobileMenuLink {
  href: string;
  label: string;
}

interface SiteMobileMenuProps {
  /** Visibility classes of the whole group (NAV_LAYOUT.narrow): it exists only below the breakpoint. */
  className: string;
  /** Name of the button ("Menyu") and of the menu's navigation. */
  menuLabel: string;
  items: readonly MobileMenuLink[];
  login: MobileMenuLink;
  /** "Open in Telegram"; null when the bot link is not configured. */
  telegram: MobileMenuLink | null;
  languageLabel: string;
  /** The language switch, drawn by the server (it is plain links). */
  langSwitch: ReactNode;
}

/**
 * Site.dc.html `menuOpen`: "Kirish" and the menu button in the bar; under it the panel with the
 * three sections, the language and the Telegram button. A disclosure, not a dialog: the page
 * behind stays usable. Escape closes it and gives the focus back to the button; so does a tap
 * outside, and following a link.
 */
export function SiteMobileMenu({
  className,
  menuLabel,
  items,
  login,
  telegram,
  languageLabel,
  langSwitch,
}: SiteMobileMenuProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div ref={root} className={cn('ml-auto items-center gap-1.5', className)}>
      <Link
        href={login.href}
        prefetch={false}
        className={cn(
          'relative flex h-11 items-center rounded-control px-3 text-sm font-bold text-foreground no-underline',
          LINK_FOCUS,
        )}
      >
        {login.label}
      </Link>
      <button
        ref={button}
        type="button"
        aria-label={menuLabel}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'grid size-11 cursor-pointer place-items-center rounded-control border-[1.5px] border-border bg-card text-foreground',
          LINK_FOCUS,
        )}
      >
        <Icon icon={open ? X : Menu} size={20} />
      </button>
      {/* Always in the document, `hidden` while closed: the links stay readable for crawlers and
          leave the tab order. It hangs from the header (the nearest positioned ancestor). */}
      <div
        id={panelId}
        hidden={!open}
        className="absolute inset-x-0 top-full flex max-h-[calc(100dvh-64px)] flex-col gap-1 overflow-y-auto border-t border-border bg-surface px-4 pt-2 pb-5 shadow-lg"
      >
        <nav aria-label={menuLabel} className="flex flex-col gap-1">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={close}
              className={cn(
                'flex h-[52px] items-center justify-between border-b border-border text-base font-bold text-foreground no-underline',
                LINK_FOCUS,
              )}
            >
              {item.label}
              <Icon icon={ChevronRight} size={18} className="text-foreground-muted" />
            </Link>
          ))}
        </nav>
        <div className="flex h-14 items-center justify-between">
          <span className="text-sm font-semibold text-foreground-muted">{languageLabel}</span>
          {langSwitch}
        </div>
        {telegram === null ? null : (
          <a
            href={telegram.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={close}
            className={cn(
              'relative flex h-[52px] items-center justify-center gap-2 rounded-tile bg-primary text-base font-extrabold text-primary-foreground no-underline shadow-glow hover:bg-primary-hover',
              HIT_AREA_LINK,
              LINK_FOCUS,
            )}
          >
            <Icon icon={Send} size={17} />
            {telegram.label}
          </a>
        )}
      </div>
    </div>
  );
}
