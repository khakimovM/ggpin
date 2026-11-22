import { CHART_FILL, CHART_STROKE, clampRatio, type ChartTone } from '../lib/chart-tones';
import { cn } from '../lib/cn';

export interface AreaSeries {
  id: string;
  /** Heights as 0..1 of the chart's top value, oldest first (the caller scales its BigInts). */
  ratios: readonly number[];
  tone: ChartTone;
  /** Fill opacity of the area under the line (design: 0.16 and 0.22). */
  fillOpacity?: number;
}

export interface AreaChartProps {
  /** Accessible description of what the picture shows. */
  label: string;
  series: readonly AreaSeries[];
  /** Axis texts top, middle, bottom ("5 mln", "2,5 mln", "0"). */
  yLabels: readonly [string, string, string];
  /** A few evenly spaced x-axis texts. */
  xLabels: readonly string[];
  height?: number;
  className?: string;
}

const W = 600;

function points(ratios: readonly number[], height: number): [number, number][] {
  const last = Math.max(ratios.length - 1, 1);
  return ratios.map((ratio, index) => [(index / last) * W, height - clampRatio(ratio) * height]);
}

function linePath(ratios: readonly number[], height: number): string {
  return points(ratios, height)
    .map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(' ');
}

/**
 * Line + area chart of the dashboard ("Aylanma va foyda", Admin.dc.html): a 600x180 SVG stretched
 * to the card, three horizontal guides, one translucent area and a 2px line per series.
 */
export function AreaChart({
  label,
  series,
  yLabels,
  xLabels,
  height = 180,
  className,
}: AreaChartProps) {
  return (
    <div className={cn('grid grid-cols-[40px_minmax(0,1fr)] gap-1.5', className)}>
      <div
        aria-hidden="true"
        className="flex flex-col justify-between pb-[18px] text-right text-[10px] leading-3 font-semibold text-foreground-muted tabular-nums"
      >
        {yLabels.map((text, index) => (
          <span key={index}>{text}</span>
        ))}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <svg
          viewBox={`0 0 ${W} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
          className="block w-full"
          style={{ height }}
        >
          <line x1="0" y1="0.5" x2={W} y2="0.5" className="stroke-border" strokeWidth="1" />
          <line
            x1="0"
            y1={height / 2}
            x2={W}
            y2={height / 2}
            className="stroke-border"
            strokeWidth="1"
            strokeDasharray="4 4"
          />
          <line
            x1="0"
            y1={height - 0.5}
            x2={W}
            y2={height - 0.5}
            className="stroke-border"
            strokeWidth="1"
          />
          {series.map((one) =>
            one.ratios.length > 0 ? (
              <g key={one.id}>
                <path
                  d={`${linePath(one.ratios, height)} L${W} ${height} L0 ${height} Z`}
                  className={CHART_FILL[one.tone]}
                  fillOpacity={one.fillOpacity ?? 0.16}
                />
                <path
                  d={linePath(one.ratios, height)}
                  fill="none"
                  className={CHART_STROKE[one.tone]}
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            ) : null,
          )}
        </svg>
        <div
          aria-hidden="true"
          className="flex justify-between text-[10px] leading-3 font-semibold text-foreground-muted tabular-nums"
        >
          {xLabels.map((text, index) => (
            <span key={index}>{text}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
