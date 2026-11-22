import type { ReactNode } from 'react';

interface Props {
  title: string;
  /** Muted line under the title ("Jami 18 420 · bugun +312"). */
  sub?: ReactNode;
  /** Buttons on the right (export, refresh). */
  actions?: ReactNode;
  /** Chips next to the title (status of the object). */
  badges?: ReactNode;
}

/** The page title row of every admin screen (Admin.dc.html: 22/28 extrabold, actions right). */
export function PageHeader({ title, sub, actions, badges }: Props) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="m-0 text-[22px] leading-7 font-extrabold tracking-[-.01em]">{title}</h1>
          {badges}
        </div>
        {sub ? (
          <p className="m-0 text-xs leading-4 font-semibold text-foreground-muted tabular-nums">
            {sub}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
