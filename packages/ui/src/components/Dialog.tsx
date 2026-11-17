'use client';

import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Dialog as RadixDialog } from 'radix-ui';
import { useRef, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { DURATION, EASE, REDUCED_FADE, useReducedMotion } from '../lib/motion';
import { FOCUS_RING } from '../lib/styles';
import { Icon } from './Icon';

export interface DialogProps {
  open: boolean;
  /** Called with false for Escape, an overlay press and the close button. */
  onOpenChange: (open: boolean) => void;
  title: string;
  /** The line under the title (what the action does, to which record). */
  description?: ReactNode;
  /** An <Icon> shown on the tone's soft square, left of the title. */
  icon?: ReactNode;
  /** danger: a destructive action (red accent line and icon); primary otherwise. */
  tone?: 'primary' | 'danger';
  /** Accessible name of the close button. */
  closeLabel: string;
  children?: ReactNode;
  /** The action row (cancel + confirm), right-aligned. */
  footer?: ReactNode;
  /** While true, Escape and an overlay press do not close it (a request is in flight). */
  dismissible?: boolean;
  className?: string;
}

const TONE = {
  primary: { accent: 'border-t-primary', icon: 'bg-primary-soft text-primary-soft-foreground' },
  danger: { accent: 'border-t-danger', icon: 'bg-danger-soft text-danger' },
} as const;

/**
 * The desktop action dialog of the admin panel (Admin.dc.html dialogs): max 480 wide, a 4px accent
 * line on top, icon + title + description, body, and a right-aligned action row. Radix supplies
 * the focus trap, Escape, scroll lock and aria; motion the fade and scale (a fade alone under
 * reduced motion).
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  icon,
  tone = 'primary',
  closeLabel,
  children,
  footer,
  dismissible = true,
  className,
}: DialogProps) {
  const reduced = useReducedMotion();
  const opener = useRef<HTMLElement | null>(null);
  const hidden = reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 };
  const shown = reduced ? { opacity: 1 } : { opacity: 1, scale: 1 };
  const guard = (event: Event) => {
    if (!dismissible) event.preventDefault();
  };

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
            <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4 md:p-6">
              <RadixDialog.Content
                forceMount
                asChild
                onEscapeKeyDown={guard}
                onPointerDownOutside={guard}
                onInteractOutside={guard}
                // Opened by app state, not by a Dialog.Trigger: the opener is remembered here and
                // focused again on close.
                onOpenAutoFocus={() => {
                  opener.current =
                    document.activeElement instanceof HTMLElement ? document.activeElement : null;
                }}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  opener.current?.focus();
                }}
                {...(description ? {} : { 'aria-describedby': undefined })}
              >
                <motion.div
                  initial={hidden}
                  animate={{
                    ...shown,
                    transition: reduced
                      ? REDUCED_FADE
                      : { duration: DURATION.base, ease: EASE.out },
                  }}
                  exit={{
                    ...hidden,
                    transition: reduced ? REDUCED_FADE : { duration: DURATION.fast, ease: EASE.in },
                  }}
                  className={cn(
                    'pointer-events-auto flex max-h-[90dvh] w-full max-w-[480px] flex-col gap-3.5 overflow-y-auto',
                    'rounded-[18px] border border-t-4 border-border bg-elevated p-5 text-foreground shadow-lg',
                    'focus-visible:outline-none',
                    TONE[tone].accent,
                    className,
                  )}
                >
                  <div className="flex items-start gap-3">
                    {icon ? (
                      <span
                        className={cn(
                          'grid size-10 flex-none place-items-center rounded-control',
                          TONE[tone].icon,
                        )}
                      >
                        {icon}
                      </span>
                    ) : null}
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <RadixDialog.Title className="m-0 text-[17px] leading-[22px] font-extrabold">
                        {title}
                      </RadixDialog.Title>
                      {description ? (
                        <RadixDialog.Description className="m-0 text-[13px] leading-[19px] font-semibold text-foreground-secondary tabular-nums">
                          {description}
                        </RadixDialog.Description>
                      ) : null}
                    </div>
                    <RadixDialog.Close
                      aria-label={closeLabel}
                      disabled={!dismissible}
                      className={cn(
                        'grid size-8 flex-none place-items-center rounded-[9px] bg-muted text-foreground disabled:opacity-50',
                        FOCUS_RING,
                      )}
                    >
                      <Icon icon={X} size={16} />
                    </RadixDialog.Close>
                  </div>
                  {children}
                  {footer ? <div className="flex flex-wrap justify-end gap-2">{footer}</div> : null}
                </motion.div>
              </RadixDialog.Content>
            </div>
          </RadixDialog.Portal>
        ) : null}
      </AnimatePresence>
    </RadixDialog.Root>
  );
}
