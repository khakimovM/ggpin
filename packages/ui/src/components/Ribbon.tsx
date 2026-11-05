import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface RibbonProps {
  children: ReactNode;
  /**
   * Which top corner it hangs from. "end" (default) is safe in every language: the longer
   * Russian "Выгоднее всего" grows leftward over the tile instead of past its edge (Russian QA
   * fix 4). "start" is the Uzbek frame of the design.
   */
  anchor?: 'start' | 'end';
  className?: string;
}

// Sits half above the top edge of a tile, so the tile (or its wrapper) must be `relative`.
export function Ribbon({ children, anchor = 'end', className }: RibbonProps) {
  return (
    <span
      className={cn(
        'pointer-events-none absolute -top-[9px] h-[18px] rounded-xs bg-accent px-2 text-[10px] leading-[18px] font-extrabold whitespace-nowrap text-accent-foreground',
        anchor === 'start' ? 'left-3' : 'right-3',
        className,
      )}
    >
      {children}
    </span>
  );
}
