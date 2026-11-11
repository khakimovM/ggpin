import type { ReactNode } from 'react';
import type { DayGroup } from './group-by-day';

/** Day headings over cards of rows (Account.dc.html `groups`). */
export function DaySections<T>({
  groups,
  row,
}: {
  groups: readonly DayGroup<T>[];
  row: (item: T) => ReactNode;
}) {
  return (
    <>
      {groups.map((group) => (
        <section key={group.key} className="flex flex-col gap-2">
          <h2 className="m-0 px-1 text-[13px] leading-[18px] font-bold tracking-[.04em] text-foreground-muted uppercase">
            {group.label}
          </h2>
          <div className="overflow-hidden rounded-[20px] border border-border bg-card">
            {group.items.map(row)}
          </div>
        </section>
      ))}
    </>
  );
}
