import type { LucideIcon } from 'lucide-react';
import { cn } from '../lib/cn';
import { CHART_TEXT, type ChartTone } from '../lib/chart-tones';
import { Icon } from './Icon';

export interface KpiCardProps {
  label: string;
  icon: LucideIcon;
  /** Colour of the icon: a chart tone (1–8) or `success`. */
  tone: ChartTone | 'success';
  /** Already formatted ("48 200 000", "99,4", "1 daq 12 s"). */
  value: string;
  /** Small muted suffix ("so‘m", "%"), with its own leading space if it needs one. */
  unit?: string;
  className?: string;
}

/** One dashboard figure (Admin.dc.html `kpis`): icon + label, then the large tabular value. */
export function KpiCard({ label, icon, tone, value, unit, className }: KpiCardProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-md border border-border bg-card px-3.5 py-3',
        className,
      )}
    >
      <span className="flex items-center gap-1.5 text-[11px] leading-[14px] font-bold text-foreground-muted">
        <Icon
          icon={icon}
          size={13}
          className={tone === 'success' ? 'text-success' : CHART_TEXT[tone]}
        />
        {label}
      </span>
      <span className="text-xl leading-[26px] font-extrabold tracking-[-.01em] whitespace-nowrap tabular-nums">
        {value}
        {unit ? (
          <span className="text-xs leading-none font-bold text-foreground-muted">{unit}</span>
        ) : null}
      </span>
    </div>
  );
}
