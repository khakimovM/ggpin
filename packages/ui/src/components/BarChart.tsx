import { CHART_BG, clampRatio, type ChartTone } from '../lib/chart-tones';
import { cn } from '../lib/cn';

export interface BarRow {
  id: string;
  label: string;
  /** Formatted figure on the right ("21 400 000 so‘m"). */
  value: string;
  /** Bar length as 0..1 of the longest bar (computed by the caller). */
  ratio: number;
  tone: ChartTone;
}

export interface BarChartProps {
  label: string;
  rows: readonly BarRow[];
  className?: string;
}

/**
 * Horizontal bars of the dashboard ("To‘lov usullari bo‘yicha", Admin.dc.html): label and figure
 * on one line, a 10px rounded track under it. A list, so screen readers read every row.
 */
export function BarChart({ label, rows, className }: BarChartProps) {
  return (
    <ul aria-label={label} className={cn('m-0 flex list-none flex-col gap-3 p-0', className)}>
      {rows.map((row) => (
        <li key={row.id} className="flex flex-col gap-[5px]">
          <span className="flex justify-between gap-2 text-xs leading-4 font-bold tabular-nums">
            <span>{row.label}</span>
            <span className="text-foreground-secondary">{row.value}</span>
          </span>
          <span className="h-2.5 overflow-hidden rounded-[5px] bg-muted">
            <span
              className={cn('block h-full rounded-[5px]', CHART_BG[row.tone])}
              style={{ width: `${(clampRatio(row.ratio) * 100).toFixed(1)}%` }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}
