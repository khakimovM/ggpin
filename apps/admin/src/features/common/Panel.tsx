import { cn } from '@repo/ui';
import type { ReactNode } from 'react';

interface Props {
  title?: string;
  /** Right side of the title row (a link, a muted note). */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Heading id, so a region can be labelled by it. */
  id?: string;
}

/** A card section of a screen (design: 14px radius, 14px padding, 14/18 extrabold title). */
export function Panel({ title, aside, children, className, id }: Props) {
  return (
    <section
      aria-labelledby={title && id ? id : undefined}
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-md border border-border bg-card p-3.5',
        className,
      )}
    >
      {title ? (
        <div className="flex items-center justify-between gap-2">
          <h2 id={id} className="m-0 text-sm leading-[18px] font-extrabold">
            {title}
          </h2>
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}
