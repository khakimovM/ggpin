import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { FOCUS_RING } from '../lib/styles';
import { Icon } from './Icon';

export interface SidebarItem {
  id: string;
  label: string;
  icon: LucideIcon;
  href: string;
  /** A count next to the label (a dot on the icon rail); warning amber or danger red. */
  badge?: { text: string; tone: 'warning' | 'danger' };
}

export interface SidebarGroup {
  id: string;
  title: string;
  items: readonly SidebarItem[];
}

export interface SidebarLinkProps {
  href: string;
  className: string;
  title: string;
  'aria-current': 'page' | undefined;
  children: ReactNode;
}

export interface SidebarProps {
  /** Accessible name of the navigation landmark ("Admin menyu"). */
  label: string;
  /** The 60px top row: the logo (and, from 1024px, the product chip). */
  header: ReactNode;
  groups: readonly SidebarGroup[];
  /** Id of the item of the current page. */
  currentId: string | null;
  /** Renders one link, so the app's router owns navigation (react-router <Link>, <a>, ...). */
  renderLink: (props: SidebarLinkProps) => ReactNode;
  className?: string;
}

const BADGE = {
  warning: 'bg-warning text-accent-foreground',
  danger: 'bg-danger-hover text-danger-foreground dark:bg-danger dark:text-background',
} as const;

/**
 * The admin sidebar (Admin.dc.html): 248px with group titles and labels from 1024px, a 64px icon
 * rail below it (the 768 frame). The rail keeps every label for assistive tech (visually hidden)
 * and as a tooltip. Responsive by CSS alone, so it never flashes the other layout.
 */
export function Sidebar({ label, header, groups, currentId, renderLink, className }: SidebarProps) {
  return (
    <aside
      className={cn(
        'flex min-h-full w-16 flex-none flex-col border-r border-border bg-surface lg:w-[248px]',
        className,
      )}
    >
      <div className="flex h-[60px] flex-none items-center justify-center gap-2.5 border-b border-border lg:justify-start lg:px-4">
        {header}
      </div>
      <nav
        aria-label={label}
        className="flex flex-1 flex-col gap-3.5 overflow-y-auto px-2 py-2.5 lg:px-2.5"
      >
        {groups.map((group) => (
          <div key={group.id} className="flex flex-col gap-px">
            <span className="hidden px-2.5 pt-1 pb-1.5 text-[10px] leading-[14px] font-extrabold tracking-[.08em] text-foreground-muted uppercase lg:block">
              {group.title}
            </span>
            <ul className="m-0 flex list-none flex-col gap-px p-0">
              {group.items.map((item) => {
                const current = item.id === currentId;
                return (
                  <li key={item.id}>
                    {renderLink({
                      href: item.href,
                      title: item.label,
                      'aria-current': current ? 'page' : undefined,
                      className: cn(
                        'relative flex h-9 items-center justify-center gap-2.5 rounded-[9px] px-2.5 text-[13px] leading-none no-underline lg:justify-start',
                        'transition-colors duration-fast ease-standard hover:bg-muted hover:text-foreground',
                        current
                          ? 'bg-primary-soft font-extrabold text-primary-soft-foreground'
                          : 'font-bold text-foreground-secondary',
                        FOCUS_RING,
                      ),
                      children: (
                        <>
                          <Icon icon={item.icon} size={16} className="flex-none" />
                          <span className="sr-only flex-1 truncate lg:not-sr-only">
                            {item.label}
                          </span>
                          {item.badge ? (
                            <span
                              className={cn(
                                'absolute top-1 right-1.5 h-[18px] min-w-5 rounded-full px-1.5 text-center text-[10px] leading-[18px] font-extrabold lg:static',
                                BADGE[item.badge.tone],
                              )}
                            >
                              {item.badge.text}
                            </span>
                          ) : null}
                        </>
                      ),
                    })}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}
