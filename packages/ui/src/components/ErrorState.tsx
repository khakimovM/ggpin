import { RefreshCw, WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Button } from './Button';
import { Icon } from './Icon';

export interface ErrorStateProps {
  title: string;
  description?: string;
  /** Label of the retry button, i18n `common.retry` ("Qayta urinish"). */
  retryLabel: string;
  onRetry: () => void;
  /** Replace the default offline icon (24px). */
  icon?: ReactNode;
  /** Disable and show a spinner while a retry is running. */
  retrying?: boolean;
  framed?: boolean;
  className?: string;
}

// One line of explanation plus "Qayta urinish". role="alert" so the failure is announced.
export function ErrorState({
  title,
  description,
  retryLabel,
  onRetry,
  icon,
  retrying = false,
  framed = true,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-2.5 px-3 py-4 text-center',
        framed && 'rounded-lg border border-border bg-card',
        className,
      )}
    >
      <span className="grid size-[52px] place-items-center rounded-full bg-danger-soft text-danger">
        {icon ?? <Icon icon={WifiOff} size={24} />}
      </span>
      <span className="text-sm leading-5 font-extrabold text-balance">{title}</span>
      {description ? (
        <span className="max-w-xs text-xs leading-4 font-medium text-foreground-muted text-balance">
          {description}
        </span>
      ) : null}
      <Button
        variant="outline"
        size="md"
        loading={retrying}
        onClick={onRetry}
        className="text-[13px]"
      >
        {retrying ? null : <Icon icon={RefreshCw} size={15} />}
        {retryLabel}
      </Button>
    </div>
  );
}
