import { CircleCheck, PackageX } from 'lucide-react';
import { cn } from '../lib/cn';
import { Icon } from './Icon';

export interface StockChipProps {
  state: 'inStock' | 'low' | 'soldOut';
  /** Localised text, e.g. "Mavjud", "69 ta qoldi", "Tugagan". */
  label: string;
  className?: string;
}

export function StockChip({ state, label, className }: StockChipProps) {
  return (
    <span
      data-stock={state}
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-badge px-2 text-[11px] leading-none font-extrabold whitespace-nowrap tabular-nums',
        state === 'inStock' && 'bg-success-soft text-success-text',
        state === 'low' && 'bg-warning-soft text-warning-text',
        state === 'soldOut' && 'bg-muted text-foreground-muted',
        className,
      )}
    >
      {state === 'soldOut' ? <Icon icon={PackageX} size={12} /> : null}
      {state === 'inStock' ? <Icon icon={CircleCheck} size={12} /> : null}
      {label}
    </span>
  );
}
