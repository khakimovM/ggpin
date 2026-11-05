import { Slot } from 'radix-ui';
import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn';
import { FOCUS_RING } from '../lib/styles';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** card: default surface; elevated: dropdowns and sheets; muted: quiet inset block. */
  variant?: 'card' | 'elevated' | 'muted';
  padding?: 'none' | 'md' | 'lg';
  /** Lifts on hover (product cards, order rows). Pair with `asChild` on a link. */
  interactive?: boolean;
  /** Render as the child element (a link, a section) with the card styles. */
  asChild?: boolean;
}

export function Card({
  variant = 'card',
  padding = 'md',
  interactive = false,
  asChild = false,
  className,
  ...rest
}: CardProps) {
  const Component = asChild ? Slot.Root : 'div';
  return (
    <Component
      className={cn(
        'rounded-lg border border-border text-foreground',
        variant === 'card' && 'bg-card shadow-sm',
        variant === 'elevated' && 'bg-elevated shadow-md',
        variant === 'muted' && 'border-transparent bg-muted',
        padding === 'md' && 'p-4',
        padding === 'lg' && 'p-5',
        interactive &&
          cn(
            'block no-underline transition duration-base ease-out hover:-translate-y-0.5 hover:shadow-md',
            FOCUS_RING,
          ),
        className,
      )}
      {...rest}
    />
  );
}
