'use client';

import { Ban, Check, ScanSearch, Undo2, X, type LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { DURATION, EASE, useReducedMotion } from '../lib/motion';
import { Icon } from './Icon';
import { Spinner } from './Spinner';

export type TimelineState = 'done' | 'active' | 'pending';

/**
 * How a step that is not the plain happy path looks (Checkout.dc.html `order`): `warning` is a step
 * under review, `danger` a failure, `muted` a cancellation, `refund` money returned. Colour never
 * travels alone: each has its own icon, and the title says what it is.
 */
export type TimelineTone = 'warning' | 'danger' | 'muted' | 'refund';

export interface TimelineItem {
  id: string;
  state: TimelineState;
  tone?: TimelineTone;
  title: string;
  /** Time or hint under the title, e.g. "Bugun, 14:02". */
  description?: ReactNode;
}

export interface TimelineProps {
  items: readonly TimelineItem[];
  /** Accessible name of the list, e.g. "Buyurtma holati". */
  ariaLabel?: string;
  /**
   * Spoken state of each step, e.g. { done: "Bajarildi", active: "Joriy qadam", pending:
   * "Kutilmoqda" }. Colour and icon alone are not available to a screen reader.
   */
  stateLabels: Record<TimelineState, string>;
  /** Lead-in of the live announcement, e.g. "Joriy qadam" -> "Joriy qadam: Yuborilmoqda". */
  currentLabel: string;
  /**
   * `lg` is the web order page of Store.dc.html: 32px dots, a 17px title and the time in a column
   * of its own on the right. `md` (default) is the Mini App's compact list.
   */
  size?: 'md' | 'lg';
  className?: string;
}

const TONE_LOOK: Record<TimelineTone, { icon: LucideIcon; dot: string; title: string }> = {
  warning: { icon: ScanSearch, dot: 'bg-warning text-card', title: 'text-warning-text' },
  danger: { icon: X, dot: 'bg-danger text-card', title: 'text-danger-text' },
  muted: { icon: Ban, dot: 'bg-foreground-muted text-card', title: 'text-foreground-secondary' },
  refund: { icon: Undo2, dot: 'bg-success text-card', title: 'text-success-text' },
};

function Connector({ kind, grow }: { kind: 'done' | 'toActive' | 'pending'; grow: boolean }) {
  const reduced = useReducedMotion();
  if (kind === 'pending') {
    return <span className="min-h-[18px] w-0 flex-1 border-l-2 border-dashed border-border" />;
  }
  return (
    // Remounted when the step becomes done, so the line grows once (dur-slow, after the dot fill).
    <motion.span
      aria-hidden="true"
      initial={grow && !reduced ? { scaleY: 0 } : false}
      animate={{ scaleY: 1 }}
      transition={{ duration: DURATION.slow, delay: DURATION.fast, ease: EASE.standard }}
      className={cn(
        'min-h-[18px] w-0.5 flex-1 origin-top',
        kind === 'done' ? 'bg-success' : 'bg-[linear-gradient(var(--success),var(--info))]',
      )}
    />
  );
}

// Order status steps. Every step carries its state as hidden text, and a separate polite live
// region announces only the current step when it changes (an aria-live list would re-read all
// of it). The active dot spins and pulses (gg-pulse); both stop under reduced motion via tokens.css.
export function Timeline({
  items,
  ariaLabel,
  stateLabels,
  currentLabel,
  size = 'md',
  className,
}: TimelineProps) {
  const roomy = size === 'lg';
  const dot = roomy ? 'size-8' : 'size-6';
  const glyph = roomy ? 15 : 13;
  // Steps that turned "done" in this very update: only their connector animates (growth). Found
  // by comparing with the previous items during render (the pattern React documents for state
  // derived from earlier props); a step present from the first render never animates.
  const [previous, setPrevious] = useState(items);
  const [justDone, setJustDone] = useState<ReadonlySet<string>>(() => new Set());
  // Steps whose time label appeared in this update: it fades in (dur-fast); at first paint it does not.
  const [labelled, setLabelled] = useState<ReadonlySet<string>>(() => new Set());
  const reduced = useReducedMotion();
  if (previous !== items) {
    setPrevious(items);
    setLabelled(
      new Set(
        items
          .filter((item) => {
            const before = previous.find((p) => p.id === item.id);
            return before !== undefined && !before.description && Boolean(item.description);
          })
          .map((item) => item.id),
      ),
    );
    setJustDone(
      new Set(
        items
          .filter((item) => {
            const before = previous.find((p) => p.id === item.id);
            return item.state === 'done' && before !== undefined && before.state !== 'done';
          })
          .map((item) => item.id),
      ),
    );
  }

  // The step to announce: the active one, else the last finished one (everything done).
  const current =
    items.find((item) => item.state === 'active') ??
    [...items].reverse().find((item) => item.state === 'done');

  return (
    <div className={className}>
      <p role="status" className="sr-only">
        {current ? `${currentLabel}: ${current.title}` : null}
      </p>
      <ol aria-label={ariaLabel} className="m-0 flex list-none flex-col p-0">
        {items.map((item, index) => {
          const next = items[index + 1];
          const last = index === items.length - 1;
          return (
            <li
              key={item.id}
              data-state={item.state}
              aria-current={item.state === 'active' ? 'step' : undefined}
              className={cn(
                roomy
                  ? 'grid grid-cols-[32px_minmax(0,1fr)_auto] gap-4'
                  : 'grid grid-cols-[24px_minmax(0,1fr)] gap-3',
              )}
            >
              <span className="flex flex-col items-center">
                {item.tone ? (
                  <span
                    data-dot=""
                    className={cn(
                      'grid place-items-center rounded-full transition-colors duration-base ease-standard',
                      dot,
                      TONE_LOOK[item.tone].dot,
                    )}
                  >
                    <Icon icon={TONE_LOOK[item.tone].icon} size={glyph} />
                  </span>
                ) : item.state === 'done' ? (
                  <span
                    data-dot=""
                    className={cn(
                      'grid place-items-center rounded-full bg-success text-card transition-colors duration-base ease-standard',
                      dot,
                    )}
                  >
                    <Icon icon={Check} size={glyph} />
                  </span>
                ) : item.state === 'active' ? (
                  <span data-dot="" className={cn('relative grid place-items-center', dot)}>
                    <span
                      aria-hidden="true"
                      className="absolute inset-0 animate-[gg-pulse_1400ms_var(--ease-out)_infinite] rounded-full bg-info"
                    />
                    <span
                      className={cn(
                        'relative grid place-items-center rounded-full bg-info text-card',
                        dot,
                      )}
                    >
                      <Spinner size={roomy ? 16 : 14} />
                    </span>
                  </span>
                ) : (
                  <span
                    data-dot=""
                    className={cn('rounded-full border-2 border-border bg-card', dot)}
                  />
                )}
                {last ? null : (
                  <Connector
                    key={`${item.id}-${item.state}`}
                    kind={
                      item.state === 'done'
                        ? next?.state === 'active'
                          ? 'toActive'
                          : 'done'
                        : 'pending'
                    }
                    grow={justDone.has(item.id)}
                  />
                )}
              </span>
              <span
                className={cn('flex flex-col gap-0.5', roomy ? 'pt-1 pb-6' : last ? '' : 'pb-4')}
              >
                <span
                  className={cn(
                    roomy ? 'text-[17px] leading-6' : 'text-sm leading-5',
                    item.state === 'active' && 'font-extrabold text-info-text',
                    item.state === 'done' && 'font-bold',
                    item.state === 'pending' && 'font-bold text-foreground-muted',
                    item.tone && cn('font-extrabold', TONE_LOOK[item.tone].title),
                  )}
                >
                  <span className="sr-only">{stateLabels[item.state]}: </span>
                  {item.title}
                </span>
                {item.description && !roomy ? (
                  <motion.span
                    initial={labelled.has(item.id) && !reduced ? { opacity: 0 } : false}
                    animate={{ opacity: 1 }}
                    transition={{ duration: DURATION.fast }}
                    className="text-xs leading-4 font-semibold text-foreground-muted"
                  >
                    {item.description}
                  </motion.span>
                ) : null}
              </span>
              {roomy ? (
                // The column is always there (the grid needs it); the time itself is mounted when it
                // arrives, so its fade runs (only when it first appears: `labelled` holds the steps that had no
                // time before; a time that merely changes is swapped in without a fade).
                item.description ? (
                  <motion.span
                    key={
                      typeof item.description === 'string' || typeof item.description === 'number'
                        ? item.description
                        : item.id
                    }
                    initial={labelled.has(item.id) && !reduced ? { opacity: 0 } : false}
                    animate={{ opacity: 1 }}
                    transition={{ duration: DURATION.fast }}
                    className="pt-1.5 text-sm leading-5 font-bold text-foreground-muted tabular-nums"
                  >
                    {item.description}
                  </motion.span>
                ) : (
                  <span aria-hidden="true" />
                )
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
