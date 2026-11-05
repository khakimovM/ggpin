import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

export type BadgeVariant =
  'region' | 'regionOnImage' | 'auto' | 'code' | 'popular' | 'premium' | 'soon' | 'neutral';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /**
   * region: Global / SNG / UZ; regionOnImage: the same, filled, over a product image;
   * auto / code: delivery (Avto / Promokod); popular: Mashhur; premium; soon: Tez orada.
   */
  variant?: BadgeVariant;
  /** md: 24px, in lists. sm: 22px, over product images. */
  size?: 'md' | 'sm';
  icon?: ReactNode;
}

const VARIANTS: Record<BadgeVariant, string> = {
  region: 'bg-muted text-foreground-secondary',
  regionOnImage: 'bg-primary text-primary-foreground',
  auto: 'bg-success-soft text-success-text',
  code: 'bg-accent-soft text-accent-soft-foreground',
  popular: 'bg-accent text-accent-foreground',
  // --premium on --premium-soft is only 4.0:1 in the light theme; --primary-soft-foreground is 7.1:1
  // there (dark keeps the designed --premium, 5.9:1).
  premium: 'bg-premium-soft text-primary-soft-foreground dark:text-premium',
  soon: 'bg-elevated text-foreground-secondary',
  neutral: 'bg-muted text-foreground-muted',
};

// Badge labels are short by design (a word or two); they stay on one line.
export function Badge({
  variant = 'region',
  size = 'md',
  icon,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 font-extrabold whitespace-nowrap',
        size === 'md'
          ? 'h-6 rounded-badge px-2 text-[11px] leading-none'
          : 'h-[22px] rounded-[7px] px-[7px] text-[10px] leading-none',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </span>
  );
}
