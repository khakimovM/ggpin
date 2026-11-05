'use client';

import { Check } from 'lucide-react';
import { motion } from 'motion/react';
import { useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { DURATION, EASE, useReducedMotion } from '../lib/motion';
import { Icon } from './Icon';
import { Spinner } from './Spinner';

export type TimelineState = 'done' | 'active' | 'pending';

export interface TimelineItem {
  id: string;
  state: TimelineState;
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
  className?: string;
}

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
  className,
}: TimelineProps) {
  // Steps that turned "done" in this very update: only their connector animates (growth). Found
  // by comparing with the previous items during render (the pattern React documents for state
  // derived from earlier props); a step present from the first render never animates.
  const [previous, setPrevious] = useState(items);
  const [justDone, setJustDone] = useState<ReadonlySet<string>>(() => new Set());
  if (previous !== items) {
    setPrevious(items);
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
              className="grid grid-cols-[24px_minmax(0,1fr)] gap-3"
            >
              <span className="flex flex-col items-center">
                {item.state === 'done' ? (
                  <span className="grid size-6 place-items-center rounded-full bg-success text-card transition-colors duration-base ease-standard">
                    <Icon icon={Check} size={13} />
                  </span>
                ) : item.state === 'active' ? (
                  <span className="relative grid size-6 place-items-center">
                    <span
                      aria-hidden="true"
                      className="absolute inset-0 animate-[gg-pulse_1600ms_var(--ease-out)_infinite] rounded-full bg-info"
                    />
                    <span className="relative grid size-6 place-items-center rounded-full bg-info text-card">
                      <Spinner size={14} />
                    </span>
                  </span>
                ) : (
                  <span className="size-6 rounded-full border-2 border-border bg-card" />
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
              <span className={cn('flex flex-col gap-0.5', last ? '' : 'pb-4')}>
                <span
                  className={cn(
                    'text-sm leading-5',
                    item.state === 'active' && 'font-extrabold text-info-text',
                    item.state === 'done' && 'font-bold',
                    item.state === 'pending' && 'font-bold text-foreground-muted',
                  )}
                >
                  <span className="sr-only">{stateLabels[item.state]}: </span>
                  {item.title}
                </span>
                {item.description ? (
                  <span className="text-xs leading-4 font-semibold text-foreground-muted">
                    {item.description}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
