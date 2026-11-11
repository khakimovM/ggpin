import { Ban, CircleCheck, Clock, Pause, ScanSearch, Undo2, type LucideIcon } from 'lucide-react';
import { cn } from '../lib/cn';
import { Icon } from './Icon';
import { Spinner } from './Spinner';

// Mirrors the OrderStatus enum of packages/shared (kept local: @repo/ui has no dependency on it).
// HELD is admin-only; users see it as "being reviewed", like NEEDS_REVIEW.
export type StatusChipStatus =
  | 'PAID'
  | 'QUEUED'
  | 'PROCESSING'
  | 'NEEDS_REVIEW'
  | 'HELD'
  | 'DELIVERED'
  | 'FAILED'
  | 'REFUNDED'
  | 'CANCELLED';

export interface StatusChipProps {
  status: StatusChipStatus;
  /** Full label, e.g. "Bajarilmadi — pul qaytarildi". */
  label: string;
  /** Short label for tables, e.g. "Bajarilmadi". Used when `form` is "short". */
  shortLabel?: string;
  form?: 'long' | 'short';
  /** sm 22, md 24, lg 26, xl 28 px minimum height. */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

interface Look {
  icon: LucideIcon | 'spinner';
  classes: string;
}

// Icon + colour + text always travel together: colour is never the only signal.
const LOOKS: Record<StatusChipStatus, Look> = {
  PAID: { icon: CircleCheck, classes: 'bg-status-delivered-soft text-status-delivered' },
  QUEUED: { icon: Clock, classes: 'bg-status-queued-soft text-status-queued' },
  PROCESSING: { icon: 'spinner', classes: 'bg-status-processing-soft text-status-processing' },
  NEEDS_REVIEW: { icon: ScanSearch, classes: 'bg-status-review-soft text-status-review' },
  HELD: { icon: Pause, classes: 'bg-status-review-soft text-status-review' },
  DELIVERED: { icon: CircleCheck, classes: 'bg-status-delivered-soft text-status-delivered' },
  FAILED: { icon: Undo2, classes: 'bg-status-failed-soft text-status-failed' },
  REFUNDED: { icon: Undo2, classes: 'bg-status-failed-soft text-status-failed' },
  CANCELLED: { icon: Ban, classes: 'bg-status-cancelled-soft text-status-cancelled' },
};

const SIZES = {
  sm: { box: 'min-h-[22px] px-2 text-[11px]', icon: 12 },
  md: { box: 'min-h-6 px-[9px] text-[11px]', icon: 13 },
  lg: { box: 'min-h-[26px] px-[9px] text-xs', icon: 13 },
  xl: { box: 'min-h-7 px-2.5 text-xs', icon: 14 },
} as const;

// The longest label ("Не выполнено — деньги возвращены") must fit: the chip has a minimum
// height and the text wraps; the icon never shrinks. Tables pass the short form instead.
export function StatusChip({
  status,
  label,
  shortLabel,
  form = 'long',
  size = 'md',
  className,
}: StatusChipProps) {
  const look = LOOKS[status];
  const dims = SIZES[size];
  return (
    <span
      data-status={status}
      className={cn(
        'inline-flex max-w-full items-center gap-[5px] rounded-full py-1 leading-tight font-bold',
        dims.box,
        look.classes,
        className,
      )}
    >
      {look.icon === 'spinner' ? (
        <Spinner size={dims.icon} />
      ) : (
        <Icon icon={look.icon} size={dims.icon} className="shrink-0" />
      )}
      <span className="min-w-0 text-left">
        {form === 'short' && shortLabel ? shortLabel : label}
      </span>
    </span>
  );
}
