'use client';

import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Dialog as RadixDialog } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { DURATION, EASE, REDUCED_FADE, useReducedMotion } from '../lib/motion';
import { FOCUS_RING } from '../lib/styles';
import { Icon } from './Icon';

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name; also the visible heading unless `heading` replaces it. */
  title: string;
  /** Visible header content next to the title (a status chip). */
  badge?: ReactNode;
  closeLabel: string;
  children: ReactNode;
  className?: string;
}

/**
 * The right-hand detail panel of the admin panel (AdminOps.dc.html `drawer`): up to 480 wide,
 * full height, 60px header with the title and close, scrolling body. Radix gives the focus trap,
 * Escape, scroll lock and focus return; it slides in from the right (a fade under reduced motion).
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  badge,
  closeLabel,
  children,
  className,
}: DrawerProps) {
  const reduced = useReducedMotion();
  const hidden = reduced ? { opacity: 0 } : { x: '100%' };
  const shown = reduced ? { opacity: 1 } : { x: 0 };
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open ? (
          <RadixDialog.Portal forceMount>
            <RadixDialog.Overlay forceMount asChild>
              <motion.div
                className="fixed inset-0 z-40 bg-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduced ? REDUCED_FADE.duration : DURATION.base }}
              />
            </RadixDialog.Overlay>
            <RadixDialog.Content forceMount asChild aria-describedby={undefined}>
              <motion.aside
                initial={hidden}
                animate={{
                  ...shown,
                  transition: reduced ? REDUCED_FADE : { duration: DURATION.slow, ease: EASE.out },
                }}
                exit={{
                  ...hidden,
                  transition: reduced ? REDUCED_FADE : { duration: DURATION.base, ease: EASE.in },
                }}
                className={cn(
                  'fixed inset-y-0 right-0 z-50 flex h-dvh w-full max-w-[480px] flex-col',
                  'border-l border-border bg-elevated text-foreground shadow-lg focus-visible:outline-none',
                  className,
                )}
              >
                <div className="flex h-[60px] flex-none items-center gap-2.5 border-b border-border px-4">
                  <RadixDialog.Title className="m-0 min-w-0 truncate text-[15px] leading-5 font-extrabold">
                    {title}
                  </RadixDialog.Title>
                  {badge}
                  <RadixDialog.Close
                    aria-label={closeLabel}
                    className={cn(
                      'ml-auto grid size-8 flex-none place-items-center rounded-[9px] bg-muted text-foreground',
                      FOCUS_RING,
                    )}
                  >
                    <Icon icon={X} size={16} />
                  </RadixDialog.Close>
                </div>
                <div className="flex flex-1 flex-col gap-3 overflow-auto p-4 tabular-nums">
                  {children}
                </div>
              </motion.aside>
            </RadixDialog.Content>
          </RadixDialog.Portal>
        ) : null}
      </AnimatePresence>
    </RadixDialog.Root>
  );
}
