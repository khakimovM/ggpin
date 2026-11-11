'use client';

import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn';
import { useReducedMotion } from '../lib/motion';

export interface SkeletonProps extends HTMLAttributes<HTMLSpanElement> {
  /** rect (default radius), circle (avatars) or text (thin rounded lines). */
  shape?: 'rect' | 'circle' | 'text';
}

// A decorative placeholder: wrap the whole loading region in an element with aria-busy="true"
// and a visible/hidden status text so assistive tech hears "loading" once, not per block.
// The shimmer is removed (not just paused) under reduced motion, leaving the static fill.
export function Skeleton({ shape = 'rect', className, ...rest }: SkeletonProps) {
  const reduced = useReducedMotion();
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative block overflow-hidden bg-skeleton',
        shape === 'circle'
          ? 'rounded-full'
          : shape === 'text'
            ? 'h-2.5 rounded-[5px]'
            : 'rounded-sm',
        className,
      )}
      {...rest}
    >
      {reduced ? null : (
        <span className="absolute inset-0 -translate-x-full animate-[gg-shimmer_var(--dur-shimmer)_var(--ease-standard)_infinite] bg-[linear-gradient(90deg,transparent,var(--skeleton-shine),transparent)]" />
      )}
    </span>
  );
}
