'use client';

import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import {
  cloneElement,
  forwardRef,
  isValidElement,
  type ButtonHTMLAttributes,
  type MouseEvent,
} from 'react';
import { cn } from '../lib/cn';
import { FOCUS_RING, HIT_AREA_44 } from '../lib/styles';
import { Spinner } from './Spinner';

// Sizes: sm 36 (hit area padded to 44), md 44, lg 52, icon 44. Heights are minimums and labels
// may wrap: Russian runs 15-35% longer, so buttons never use white-space: nowrap.
export const buttonVariants = cva(
  [
    'relative inline-flex items-center justify-center gap-2 text-center font-bold text-balance',
    'select-none transition duration-fast ease-standard',
    'active:scale-[.97]',
    'disabled:pointer-events-none disabled:active:scale-100 data-disabled:pointer-events-none data-disabled:active:scale-100',
    // Loading keeps the variant colour (handoff: --primary at .92 opacity), no hover/press shift.
    'aria-busy:cursor-progress aria-busy:opacity-[.92] aria-busy:active:scale-100',
    FOCUS_RING,
  ],
  {
    variants: {
      variant: {
        primary:
          'bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-pressed aria-busy:hover:bg-primary aria-busy:active:bg-primary disabled:bg-muted disabled:text-foreground-muted disabled:shadow-none data-disabled:bg-muted data-disabled:text-foreground-muted data-disabled:shadow-none',
        secondary:
          'bg-primary-soft text-primary-soft-foreground hover:brightness-[.96] disabled:text-foreground-muted disabled:bg-muted data-disabled:text-foreground-muted data-disabled:bg-muted',
        outline:
          'border-[1.5px] border-border bg-transparent text-foreground hover:bg-muted active:border-input-border disabled:text-foreground-muted data-disabled:text-foreground-muted',
        ghost:
          'bg-transparent text-foreground-secondary hover:bg-muted hover:text-foreground disabled:text-foreground-muted data-disabled:text-foreground-muted',
        // AA contrast with white text: --danger-hover on light (5.4:1), --danger with the dark page
        // colour on dark (6.2:1). The plain --danger fill with white text measures 4.2 / 3.1.
        danger:
          'bg-danger-hover text-danger-foreground hover:bg-danger-text dark:bg-danger dark:text-background dark:hover:bg-danger-hover disabled:bg-muted disabled:text-foreground-muted dark:disabled:bg-muted dark:disabled:text-foreground-muted data-disabled:bg-muted data-disabled:text-foreground-muted dark:data-disabled:bg-muted dark:data-disabled:text-foreground-muted',
        link: 'rounded-xs bg-transparent px-1 text-primary-soft-foreground underline decoration-transparent underline-offset-4 hover:decoration-current disabled:text-foreground-muted data-disabled:text-foreground-muted',
      },
      size: {
        sm: 'min-h-9 rounded-control px-3.5 py-1.5 text-[13px] leading-tight',
        md: 'min-h-11 rounded-control px-[18px] py-2 text-[15px] leading-tight',
        lg: 'min-h-[52px] rounded-tile px-6 py-2.5 text-base leading-tight font-extrabold',
        icon: 'size-11 rounded-control p-0 text-lg',
      },
    },
    compoundVariants: [
      { variant: 'link', size: 'sm', className: 'min-h-9 px-1' },
      { variant: 'link', size: 'md', className: 'min-h-11 px-1' },
      { variant: 'link', size: 'lg', className: 'min-h-11 px-1' },
      { size: 'sm', className: HIT_AREA_44 },
    ],
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /**
   * Shows a spinner and sets aria-busy. The button is aria-disabled, not disabled: clicks are
   * ignored but it keeps keyboard focus (a disabled button drops focus mid-submit).
   */
  loading?: boolean;
  /** Primary glow shadow, used by the main purchase button only. */
  glow?: boolean;
  /** Render as the child element (e.g. a router link) with the button styles. */
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant,
    size,
    loading = false,
    glow = false,
    asChild = false,
    disabled,
    type,
    onClick,
    children,
    ...rest
  },
  ref,
) {
  const classes = cn(buttonVariants({ variant, size }), glow && 'shadow-glow', className);
  const blocked = disabled || loading;
  // Native disabled is kept for plain disabled buttons; loading and link buttons only announce
  // it and swallow the click (this also stops a submit button from submitting twice).
  const guardedClick: ButtonHTMLAttributes<HTMLButtonElement>['onClick'] = (event) => {
    if (blocked) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onClick?.(event);
  };

  if (asChild) {
    // The child's own onClick would run before the Slot's merged handler, so a blocked link
    // would still fire it. Wrap it: when blocked, it never gets called.
    const child = isValidElement<{ onClick?: (event: MouseEvent<HTMLElement>) => void }>(children)
      ? children
      : null;
    const guardedChild = child
      ? cloneElement(child, {
          onClick: (event: MouseEvent<HTMLElement>) => {
            if (blocked) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            child.props.onClick?.(event);
          },
        })
      : children;
    return (
      <Slot.Root
        ref={ref}
        className={classes}
        aria-disabled={blocked || undefined}
        aria-busy={loading || undefined}
        data-disabled={disabled ? '' : undefined}
        onClick={guardedClick}
        {...rest}
      >
        {guardedChild}
      </Slot.Root>
    );
  }

  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={classes}
      disabled={disabled}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      onClick={guardedClick}
      {...rest}
    >
      {loading ? <Spinner size={size === 'lg' ? 20 : 18} /> : null}
      {children}
    </button>
  );
});
