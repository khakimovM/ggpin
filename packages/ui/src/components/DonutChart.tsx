import { CHART_BG, CHART_STROKE, clampRatio, type ChartTone } from '../lib/chart-tones';
import { cn } from '../lib/cn';

export interface DonutSlice {
  id: string;
  label: string;
  /** Share of the whole, 0..1 (computed by the caller from its own BigInt amounts). */
  ratio: number;
  /** Formatted share for the legend ("42%"). */
  share: string;
  tone: ChartTone;
}

export interface DonutChartProps {
  label: string;
  slices: readonly DonutSlice[];
  /** The figure in the hole ("1 284") and its caption ("buyurtma"). */
  total: string;
  totalCaption: string;
  className?: string;
}

const SIZE = 148;
const STROKE = 28;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * The product-share donut of the dashboard (Admin.dc.html): a 148px ring, 92px hole with the
 * total, and the legend beside it (swatch, name, share). Drawn as SVG arcs starting at 12 o'clock.
 */
export function DonutChart({ label, slices, total, totalCaption, className }: DonutChartProps) {
  // Where each arc starts: the running sum of the arcs before it (computed up front, not mutated in render).
  const lengths = slices.map((slice) => clampRatio(slice.ratio) * CIRCUMFERENCE);
  const starts = lengths.map((_, index) =>
    lengths.slice(0, index).reduce((sum, value) => sum + value, 0),
  );
  return (
    <div className={cn('flex items-center gap-4', className)}>
      <span className="relative grid size-[148px] flex-none place-items-center">
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          role="img"
          aria-label={label}
          className="absolute inset-0 size-full -rotate-90"
        >
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
            className="stroke-muted"
          />
          {slices.map((slice, index) => {
            const length = lengths[index] ?? 0;
            const dash = `${length} ${CIRCUMFERENCE - length}`;
            const start = -(starts[index] ?? 0);
            return (
              <circle
                key={slice.id}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                strokeWidth={STROKE}
                strokeDasharray={dash}
                strokeDashoffset={start}
                className={CHART_STROKE[slice.tone]}
              />
            );
          })}
        </svg>
        <span className="relative flex flex-col items-center justify-center">
          <span className="text-lg leading-[22px] font-extrabold tabular-nums">{total}</span>
          <span className="text-[10px] leading-3 font-semibold text-foreground-muted">
            {totalCaption}
          </span>
        </span>
      </span>
      <ul className="m-0 flex min-w-0 flex-1 list-none flex-col gap-1.5 p-0">
        {slices.map((slice) => (
          <li
            key={slice.id}
            className="flex items-center gap-2 text-xs leading-4 font-semibold tabular-nums"
          >
            <span className={cn('size-[9px] flex-none rounded-[3px]', CHART_BG[slice.tone])} />
            <span className="min-w-0 flex-1 truncate text-foreground-secondary">{slice.label}</span>
            <span className="font-extrabold">{slice.share}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
