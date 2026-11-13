import { cn } from '@repo/ui';
import type { ReactNode } from 'react';
import { PRODUCT_GRID } from './landing-styles';

// A grid-shaped placeholder while the catalog is read (the Suspense fallback of the products
// block). Plain CSS, no client code: the shimmer is hidden under reduced motion, leaving the
// static fill. A block may hold invisible content that gives it the size of what it stands for
// (a button's label, say).
export function Block({ className, children }: { className: string; children?: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className={cn('relative block overflow-hidden bg-skeleton', className)}
    >
      {children}
      <span className="absolute inset-0 -translate-x-full animate-[gg-shimmer_var(--dur-shimmer)_var(--ease-standard)_infinite] bg-[linear-gradient(90deg,transparent,var(--skeleton-shine),transparent)] motion-reduce:hidden" />
    </span>
  );
}

export const SKELETON_TILES = 6;

export function ProductsSkeleton({
  label,
  tiles = SKELETON_TILES,
}: {
  label: string;
  tiles?: number;
}) {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      <ul aria-hidden="true" className={PRODUCT_GRID}>
        {Array.from({ length: tiles }, (_, index) => (
          <li
            key={index}
            className="flex flex-col gap-3 rounded-[20px] border border-border bg-card p-2 pb-3.5"
          >
            <Block className="aspect-square rounded-[14px]" />
            <span className="flex flex-col gap-2 px-1.5">
              <Block className="h-4 w-3/4 rounded-[5px]" />
              <Block className="h-5 w-1/3 rounded-xs" />
              <Block className="h-[22px] w-1/2 rounded-[5px]" />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
