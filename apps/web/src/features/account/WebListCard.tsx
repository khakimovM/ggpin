import { cn } from '@repo/ui';
import type { ReactNode } from 'react';

/** The card of the web history: rows or a table, and the pager as its footer (Store.dc.html). */
export function WebListCard({
  busy,
  footer,
  children,
}: {
  /** The next page is loading; the previous one stays, dimmed. */
  busy: boolean;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-3xl border border-border bg-card">
      <div
        aria-busy={busy}
        className={cn('transition-opacity duration-base', busy && 'opacity-60')}
      >
        {children}
      </div>
      {footer}
    </div>
  );
}
