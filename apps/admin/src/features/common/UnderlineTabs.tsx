import { FOCUS_RING, cn } from '@repo/ui';
import { Link, useLocation } from 'react-router';

export interface UnderlineTab {
  id: string;
  label: string;
  /** Muted count after the label. */
  count?: string;
}

interface Props {
  label: string;
  tabs: readonly UnderlineTab[];
  value: string;
  /** The search param that holds the tab (`tab`). Other params are dropped on a tab change. */
  param?: string;
}

/**
 * The underline tabs of the design (36px, 2px primary bar under the current one). Links, so a
 * tab is in the URL, Back works and a tab can be opened in a new browser tab.
 */
export function UnderlineTabs({ label, tabs, value, param = 'tab' }: Props) {
  const { pathname } = useLocation();
  return (
    <nav
      aria-label={label}
      className="flex items-center gap-1 overflow-x-auto border-b border-border"
    >
      {tabs.map((tab, index) => {
        const current = tab.id === value;
        return (
          <Link
            key={tab.id}
            to={index === 0 ? pathname : `${pathname}?${param}=${tab.id}`}
            aria-current={current ? 'page' : undefined}
            className={cn(
              'relative flex h-9 flex-none items-center gap-1.5 rounded-xs px-3 text-xs leading-none font-extrabold whitespace-nowrap no-underline',
              current ? 'text-foreground' : 'text-foreground-muted hover:text-foreground-secondary',
              FOCUS_RING,
            )}
          >
            {tab.label}
            {tab.count ? (
              <span className="font-semibold text-foreground-muted tabular-nums">{tab.count}</span>
            ) : null}
            <span
              aria-hidden="true"
              className={cn(
                'absolute right-2 -bottom-px left-2 h-0.5 rounded-[2px]',
                current ? 'bg-primary' : 'bg-transparent',
              )}
            />
          </Link>
        );
      })}
    </nav>
  );
}
