// The chart palette (--chart-1..8) as literal class names, so Tailwind sees every one of them.
export type ChartTone = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export const CHART_BG: Record<ChartTone, string> = {
  1: 'bg-chart-1',
  2: 'bg-chart-2',
  3: 'bg-chart-3',
  4: 'bg-chart-4',
  5: 'bg-chart-5',
  6: 'bg-chart-6',
  7: 'bg-chart-7',
  8: 'bg-chart-8',
};

export const CHART_TEXT: Record<ChartTone, string> = {
  1: 'text-chart-1',
  2: 'text-chart-2',
  3: 'text-chart-3',
  4: 'text-chart-4',
  5: 'text-chart-5',
  6: 'text-chart-6',
  7: 'text-chart-7',
  8: 'text-chart-8',
};

export const CHART_STROKE: Record<ChartTone, string> = {
  1: 'stroke-chart-1',
  2: 'stroke-chart-2',
  3: 'stroke-chart-3',
  4: 'stroke-chart-4',
  5: 'stroke-chart-5',
  6: 'stroke-chart-6',
  7: 'stroke-chart-7',
  8: 'stroke-chart-8',
};

export const CHART_FILL: Record<ChartTone, string> = {
  1: 'fill-chart-1',
  2: 'fill-chart-2',
  3: 'fill-chart-3',
  4: 'fill-chart-4',
  5: 'fill-chart-5',
  6: 'fill-chart-6',
  7: 'fill-chart-7',
  8: 'fill-chart-8',
};

/** Clamps a ratio into 0..1 (a negative profit day draws on the axis, never below it). */
export function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
