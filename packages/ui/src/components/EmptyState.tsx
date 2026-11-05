import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface EmptyStateProps {
  /** An <Icon>, 24px, shown on a soft primary disc. */
  icon: ReactNode;
  title: string;
  description?: string;
  /** The call to action, usually <Button>. Every empty state needs one. */
  action?: ReactNode;
  /** Draw the card around it (default). Turn off when it already sits inside a card. */
  framed?: boolean;
  className?: string;
}

// Empty = icon + one line + the primary action. Skeleton, error and filled states live elsewhere.
export function EmptyState({
  icon,
  title,
  description,
  action,
  framed = true,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2.5 px-3 py-4 text-center',
        framed && 'rounded-lg border border-border bg-card',
        className,
      )}
    >
      <span className="grid size-[52px] place-items-center rounded-full bg-primary-soft text-primary-soft-foreground">
        {icon}
      </span>
      <span className="text-sm leading-5 font-extrabold text-balance">{title}</span>
      {description ? (
        <span className="max-w-xs text-xs leading-4 font-medium text-foreground-muted text-balance">
          {description}
        </span>
      ) : null}
      {action}
    </div>
  );
}
