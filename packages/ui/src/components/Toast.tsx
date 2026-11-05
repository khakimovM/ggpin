import { CircleCheck, CircleX, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { FOCUS_RING, HIT_AREA_44 } from '../lib/styles';
import type { ToastTone } from '../lib/toast-context';
import { Icon } from './Icon';

interface ToastBaseProps {
  tone?: ToastTone;
  title: string;
  description?: ReactNode;
  className?: string;
}

/** The close handler and its accessible name come as a pair; one without the other is an error. */
export type ToastProps = ToastBaseProps &
  ({ onClose?: undefined; closeLabel?: undefined } | { onClose: () => void; closeLabel: string });

const TONES: Record<ToastTone, { icon: LucideIcon; classes: string }> = {
  success: { icon: CircleCheck, classes: 'bg-success-soft text-success' },
  error: { icon: CircleX, classes: 'bg-danger-soft text-danger' },
  warning: { icon: TriangleAlert, classes: 'bg-warning-soft text-warning' },
  info: { icon: Info, classes: 'bg-info-soft text-info' },
};

// The card only. It has no live-region role of its own: ToastProvider renders it inside one
// (polite, or assertive for errors), so each message is announced once. The provider also
// handles queueing, auto-dismiss and placement.
export function Toast({
  tone = 'info',
  title,
  description,
  onClose,
  closeLabel,
  className,
}: ToastProps) {
  const look = TONES[tone];
  return (
    <div
      className={cn(
        'grid grid-cols-[32px_minmax(0,1fr)_28px] items-start gap-3 rounded-tile border border-border bg-elevated p-3 shadow-md',
        className,
      )}
    >
      <span className={cn('grid size-8 place-items-center rounded-full', look.classes)}>
        <Icon icon={look.icon} size={16} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm leading-5 font-extrabold">{title}</span>
        {description ? (
          <span className="text-[13px] leading-[18px] font-medium text-foreground-secondary tabular-nums">
            {description}
          </span>
        ) : null}
      </span>
      {onClose ? (
        <button
          type="button"
          aria-label={closeLabel}
          onClick={onClose}
          className={cn(
            'relative grid size-7 place-items-center rounded-full text-foreground-muted hover:text-foreground',
            HIT_AREA_44,
            FOCUS_RING,
          )}
        >
          <Icon icon={X} size={15} />
        </button>
      ) : null}
    </div>
  );
}
