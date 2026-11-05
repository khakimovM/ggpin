'use client';

import { ArrowLeft, X } from 'lucide-react';
import { AnimatePresence, motion, useDragControls, type PanInfo } from 'motion/react';
import { Dialog, VisuallyHidden } from 'radix-ui';
import { useRef, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import {
  DURATION,
  EASE,
  REDUCED_FADE,
  SHEET_DISMISS_OFFSET,
  SHEET_DISMISS_VELOCITY,
  SPRING,
  useMediaQuery,
  useReducedMotion,
} from '../lib/motion';
import { FOCUS_RING, HIT_AREA_44 } from '../lib/styles';
import { Icon } from './Icon';

interface SheetBaseProps {
  open: boolean;
  /** Called with false for Escape, overlay press, the close button and drag-down. */
  onOpenChange: (open: boolean) => void;
  /** Required for assistive tech; visible unless `hideTitle`. */
  title: string;
  hideTitle?: boolean;
  description?: string;
  children: ReactNode;
  /** Sticky area under the content (main action). */
  footer?: ReactNode;
  /** Accessible name of the close button; the button is rendered only when this is set. */
  closeLabel?: string;
  className?: string;
}

/**
 * Multi-step sheets pass `onBack` (a back arrow in the header; the Telegram BackButton handler
 * calls the same function while the sheet is open) together with its accessible name
 * `backLabel`. One without the other does not compile: an unnamed icon button is an error.
 */
export type SheetProps = SheetBaseProps &
  ({ onBack?: undefined; backLabel?: undefined } | { onBack: () => void; backLabel: string });

// One component, two shapes: a bottom sheet below 768px (spring in, drag down to dismiss) and a
// centred modal (max 480) from 768px (scale .96 -> 1). Radix Dialog supplies the focus trap,
// Escape, scroll lock and aria; motion supplies the animation.
export function Sheet({
  open,
  onOpenChange,
  title,
  hideTitle = false,
  description,
  children,
  footer,
  onBack,
  backLabel,
  closeLabel,
  className,
}: SheetProps) {
  const desktop = useMediaQuery('(min-width: 768px)');
  const reduced = useReducedMotion();
  const dragControls = useDragControls();
  const opener = useRef<HTMLElement | null>(null);

  const onDragEnd = (_event: PointerEvent | MouseEvent | TouchEvent, info: PanInfo) => {
    if (info.offset.y > SHEET_DISMISS_OFFSET || info.velocity.y > SHEET_DISMISS_VELOCITY) {
      onOpenChange(false);
    }
  };

  const hidden = reduced ? { opacity: 0 } : desktop ? { opacity: 0, scale: 0.96 } : { y: '100%' };
  const shown = reduced ? { opacity: 1 } : desktop ? { opacity: 1, scale: 1 } : { y: 0 };
  const enter = reduced
    ? REDUCED_FADE
    : desktop
      ? { duration: DURATION.base, ease: EASE.out }
      : SPRING.sheet;
  const leave = reduced
    ? REDUCED_FADE
    : { duration: desktop ? DURATION.fast : DURATION.base, ease: EASE.in };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open ? (
          <Dialog.Portal forceMount>
            <Dialog.Overlay forceMount asChild>
              <motion.div
                data-testid="sheet-overlay"
                className="fixed inset-0 z-40 bg-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduced ? REDUCED_FADE.duration : DURATION.base }}
              />
            </Dialog.Overlay>
            <div className="pointer-events-none fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-6">
              {/* Without a description Radix wants an explicit undefined; with one it wires its own id. */}
              {/* Radix returns focus to a Dialog.Trigger only; this sheet is opened by app state, so
                  the opener is remembered here and focused again on close. */}
              <Dialog.Content
                forceMount
                asChild
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
                  animate={{ ...shown, transition: enter }}
                  exit={{ ...hidden, transition: leave }}
                  drag={desktop ? false : 'y'}
                  dragControls={dragControls}
                  dragListener={false}
                  dragConstraints={{ top: 0, bottom: 0 }}
                  dragElastic={{ top: 0, bottom: 1 }}
                  dragSnapToOrigin
                  onDragEnd={onDragEnd}
                  className={cn(
                    'pointer-events-auto flex max-h-[90dvh] w-full flex-col bg-elevated text-foreground shadow-lg',
                    'rounded-t-2xl md:max-h-[85dvh] md:max-w-[480px] md:rounded-xl md:border md:border-border',
                    'focus-visible:outline-none',
                    className,
                  )}
                >
                  {/* The handle and header are the drag area, so a scrolling body never drags. */}
                  <div
                    className="shrink-0 touch-none px-4 pt-2 md:px-5 md:pt-5"
                    onPointerDown={(event) => {
                      if (!desktop && !(event.target as HTMLElement).closest('button')) {
                        dragControls.start(event);
                      }
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className="mx-auto mb-1 block h-[5px] w-9 rounded-[3px] bg-input-border md:hidden"
                    />
                    <div className="flex items-center gap-2 pb-1 md:pb-0">
                      {onBack ? (
                        <button
                          type="button"
                          aria-label={backLabel}
                          onClick={onBack}
                          className={cn(
                            'relative -ml-1 grid size-9 shrink-0 place-items-center rounded-full bg-muted text-foreground',
                            HIT_AREA_44,
                            FOCUS_RING,
                          )}
                        >
                          <Icon icon={ArrowLeft} size={16} />
                        </button>
                      ) : null}
                      {hideTitle ? (
                        <VisuallyHidden.Root asChild>
                          <Dialog.Title>{title}</Dialog.Title>
                        </VisuallyHidden.Root>
                      ) : (
                        <Dialog.Title className="min-w-0 flex-1 text-lg leading-6 font-extrabold">
                          {title}
                        </Dialog.Title>
                      )}
                      {hideTitle ? <span className="flex-1" /> : null}
                      {closeLabel ? (
                        <Dialog.Close
                          aria-label={closeLabel}
                          className={cn(
                            'relative grid size-9 shrink-0 place-items-center rounded-full bg-muted text-foreground',
                            HIT_AREA_44,
                            FOCUS_RING,
                          )}
                        >
                          <Icon icon={X} size={16} />
                        </Dialog.Close>
                      ) : null}
                    </div>
                  </div>
                  {description ? (
                    <Dialog.Description className="px-4 pt-1 text-sm leading-5 font-medium text-foreground-secondary md:px-5">
                      {description}
                    </Dialog.Description>
                  ) : null}
                  <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5 md:px-5">
                    {children}
                  </div>
                  {footer ? (
                    <div className="shrink-0 px-4 pt-1 pb-[calc(16px+max(env(safe-area-inset-bottom),var(--tg-safe-bottom,0px)))] md:px-5 md:pb-5">
                      {footer}
                    </div>
                  ) : (
                    <div className="h-[max(env(safe-area-inset-bottom),var(--tg-safe-bottom,0px))] shrink-0 md:hidden" />
                  )}
                </motion.div>
              </Dialog.Content>
            </div>
          </Dialog.Portal>
        ) : null}
      </AnimatePresence>
    </Dialog.Root>
  );
}
