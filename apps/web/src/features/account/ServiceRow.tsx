import { Badge, Icon, cn } from '@repo/ui';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import Link from 'next/link';

export interface ServiceRowProps {
  icon: LucideIcon;
  /** Classes of the icon square: background and colour. */
  tone: string;
  label: string;
  sub?: string;
  /** A page to open. Without it the row is a "Tez orada" entry: shown, not pressable (owner Q8). */
  href?: string;
  soon?: string;
  /** Extra markup at the end of the row. */
  trailing?: ReactNode;
}

const ROW =
  'flex min-h-16 items-center gap-3 border-t border-border px-4 py-2.5 text-foreground first:border-t-0';

/** A row of the "Xizmatlar" list (Account.dc.html `services`). */
export function ServiceRow({ icon, tone, label, sub, href, soon, trailing }: ServiceRowProps) {
  const body = (
    <>
      <span
        aria-hidden="true"
        className={cn('grid size-10 shrink-0 place-items-center rounded-xl', tone)}
      >
        <Icon icon={icon} size={18} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[15px] leading-5 font-extrabold break-words">{label}</span>
        {sub === undefined ? null : (
          <span className="text-xs leading-4 font-semibold text-foreground-muted">{sub}</span>
        )}
      </span>
      {trailing}
      {href === undefined ? (
        <Badge size="sm" variant="soon">
          {soon}
        </Badge>
      ) : (
        <Icon icon={ChevronRight} size={18} className="text-foreground-muted" />
      )}
    </>
  );
  return href === undefined ? (
    <div aria-disabled="true" className={ROW}>
      {body}
    </div>
  ) : (
    <Link
      href={href}
      className={cn(
        ROW,
        'no-underline transition-colors duration-fast hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
      )}
    >
      {body}
    </Link>
  );
}
