import type { ReactNode } from 'react';

export interface HistoryColumn {
  key: string;
  label: string;
  align?: 'right';
  /** Visually hidden header (the chevron column). */
  hidden?: boolean;
}

/**
 * The desktop table of the web history (Store.dc.html `d`): a header over 64 px rows. The first
 * cell of a row holds the real link; its ::after stretches over the row, so the whole row is
 * clickable and the keyboard still meets one link per row.
 */
export function HistoryTable({
  caption,
  columns,
  children,
}: {
  caption: string;
  columns: readonly HistoryColumn[];
  children: ReactNode;
}) {
  return (
    <table className="w-full border-collapse text-sm leading-5 font-semibold tabular-nums">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="bg-surface text-left text-xs leading-4 tracking-[.05em] text-foreground-muted uppercase">
          {columns.map((column) => (
            <th
              key={column.key}
              scope="col"
              className={`px-3 py-3 font-bold first:px-5 ${column.align === 'right' ? 'text-right' : ''}`}
            >
              {column.hidden ? <span className="sr-only">{column.label}</span> : column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

export const ROW_CLASS =
  'relative h-16 border-t border-border transition-colors duration-fast hover:bg-muted';
export const LINK_CLASS =
  'text-inherit no-underline after:absolute after:inset-0 after:content-[""] hover:text-inherit focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';
