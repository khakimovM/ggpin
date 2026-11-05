import { cn } from '../lib/cn';

export interface RelativeTimeProps {
  value: Date | string | number;
  /**
   * Turns the date into text. The caller owns locale and wording: users get relative text
   * ("Bugun, 14:05"), admins get DD.MM HH:MM; this component only lays it out.
   */
  format: (date: Date) => string;
  /** Optional full timestamp shown as a tooltip. */
  titleFormat?: (date: Date) => string;
  variant?: 'user' | 'admin';
  className?: string;
}

export function RelativeTime({
  value,
  format,
  titleFormat,
  variant = 'user',
  className,
}: RelativeTimeProps) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <time
      dateTime={date.toISOString()}
      title={titleFormat?.(date)}
      // Relative text ("Bugun") differs between server and client clocks near midnight.
      suppressHydrationWarning
      className={cn(
        'tabular-nums',
        variant === 'user'
          ? 'text-xs leading-4 font-semibold text-foreground-muted'
          : 'text-[13px] leading-[18px] font-semibold text-foreground-secondary',
        className,
      )}
    >
      {format(date)}
    </time>
  );
}
