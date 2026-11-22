import type { ReactNode } from 'react';

export interface KeyValue {
  key: string;
  label: string;
  value: ReactNode;
}

/** Label / value rows of a detail card (AdminOps.dc.html "Mijoz", "Pul" cards). */
export function KeyValues({ rows }: { rows: readonly KeyValue[] }) {
  return (
    <dl className="m-0 flex flex-col">
      {rows.map((row) => (
        <div
          key={row.key}
          className="flex items-baseline justify-between gap-3 border-t border-border py-2 first:border-t-0 first:pt-0"
        >
          <dt className="text-xs leading-4 font-semibold text-foreground-muted">{row.label}</dt>
          <dd className="m-0 min-w-0 text-right text-xs leading-4 font-bold break-words tabular-nums">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
