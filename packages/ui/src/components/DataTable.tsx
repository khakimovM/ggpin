import type { MouseEvent, ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Skeleton } from './Skeleton';

export interface DataTableColumn<Row> {
  id: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  /** `end` for amounts and counts (right-aligned, like the design's money columns). */
  align?: 'start' | 'end';
  /** Extra classes of the body cell (font, colour, nowrap). */
  className?: string;
}

/** The four states every admin list has (handoff README: one shared DataTable state set). */
export type DataTableState = 'loading' | 'error' | 'empty' | 'data';

export interface DataTableProps<Row> {
  /** Accessible name of the table. */
  label: string;
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  state: DataTableState;
  /** Shown in the body for `empty` (an EmptyState with its call to action). */
  empty?: ReactNode;
  /** Shown in the body for `error` (an ErrorState with retry). */
  error?: ReactNode;
  /** Text read by screen readers while loading. */
  loadingLabel: string;
  /** A row press: the row's own link stays the keyboard path, this only widens the target. */
  onRowClick?: (row: Row) => void;
  rowClassName?: (row: Row) => string | undefined;
  /** Pager or summary under the table. */
  footer?: ReactNode;
  /** Below this width the table scrolls sideways inside its card (design: 860–1080 px). */
  minWidth?: number;
  skeletonRows?: number;
  /** Draw the card around the table (default). Off when it sits in a card already. */
  framed?: boolean;
  className?: string;
}

const HEAD =
  'bg-surface text-left text-[10px] leading-[14px] font-extrabold tracking-[.06em] text-foreground-muted uppercase';

// First and last columns get the card's 14px inset, the rest 8px (Admin.dc.html tables).
function pad(index: number, count: number): string {
  if (index === 0) return 'pr-2 pl-3.5';
  return index === count - 1 ? 'pr-3.5 pl-2' : 'px-2';
}

// A press on a link, button or field inside the row is that control's, not the row's.
function fromControl(event: MouseEvent<HTMLElement>): boolean {
  const target = event.target;
  return target instanceof Element && target.closest('a,button,input,select,textarea') !== null;
}

/**
 * The admin table (Admin.dc.html / AdminOps.dc.html): surface header with upper-case 10px labels,
 * 44px rows split by hairlines, hover tint, horizontal scroll inside the card. The skeleton,
 * empty and error states replace the body, so the frame does not jump between states.
 */
export function DataTable<Row>({
  label,
  columns,
  rows,
  rowKey,
  state,
  empty,
  error,
  loadingLabel,
  onRowClick,
  rowClassName,
  footer,
  minWidth,
  skeletonRows = 6,
  framed = true,
  className,
}: DataTableProps<Row>) {
  const count = columns.length;
  const message = state === 'empty' ? empty : state === 'error' ? error : null;
  return (
    <div
      className={cn(
        'min-w-0 overflow-hidden',
        framed && 'rounded-md border border-border bg-card',
        className,
      )}
    >
      {/* A narrow screen scrolls the table sideways: the region takes focus so a keyboard can scroll it. */}
      <div
        role="region"
        aria-label={label}
        tabIndex={0}
        className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
      >
        <table
          aria-label={label}
          aria-busy={state === 'loading'}
          style={minWidth ? { minWidth } : undefined}
          className="w-full border-collapse text-xs leading-4 font-semibold tabular-nums"
        >
          <thead>
            <tr className={HEAD}>
              {columns.map((column, index) => (
                <th
                  key={column.id}
                  scope="col"
                  className={cn(
                    'py-2.5 font-extrabold',
                    pad(index, count),
                    column.align === 'end' && 'text-right',
                  )}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state === 'loading'
              ? Array.from({ length: skeletonRows }, (_, row) => (
                  <tr key={row} className="h-11 border-t border-border">
                    {columns.map((column, index) => (
                      <td key={column.id} className={pad(index, count)}>
                        <Skeleton
                          shape="text"
                          className={cn('w-3/4 max-w-28', column.align === 'end' && 'ml-auto')}
                        />
                      </td>
                    ))}
                  </tr>
                ))
              : null}
            {message ? (
              <tr className="border-t border-border">
                <td colSpan={count} className="px-3.5 py-8">
                  {message}
                </td>
              </tr>
            ) : null}
            {state === 'data'
              ? rows.map((row) => (
                  <tr
                    key={rowKey(row)}
                    onClick={
                      onRowClick
                        ? (event) => {
                            if (!fromControl(event)) onRowClick(row);
                          }
                        : undefined
                    }
                    className={cn(
                      'h-11 border-t border-border',
                      onRowClick && 'cursor-pointer hover:bg-muted',
                      rowClassName?.(row),
                    )}
                  >
                    {columns.map((column, index) => (
                      <td
                        key={column.id}
                        className={cn(
                          'py-1.5',
                          pad(index, count),
                          column.align === 'end' && 'text-right',
                          column.className,
                        )}
                      >
                        {column.cell(row)}
                      </td>
                    ))}
                  </tr>
                ))
              : null}
          </tbody>
        </table>
      </div>
      {state === 'loading' ? (
        <span role="status" className="sr-only">
          {loadingLabel}
        </span>
      ) : null}
      {footer}
    </div>
  );
}
