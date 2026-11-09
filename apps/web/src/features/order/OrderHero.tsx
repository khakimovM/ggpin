'use client';

import { Icon, Spinner, SPRING, cn, useReducedMotion } from '@repo/ui';
import { Ban, Check, CircleX, Info, ScanSearch, Undo2, type LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import type { HeroKind } from './order-status';

interface Look {
  /** The round badge: a spinner while the order moves, an icon when it has settled. */
  badge: 'spinner' | 'pop' | { icon: LucideIcon; bg: string; fg: string };
  surface: string;
}

const LOOKS: Record<HeroKind, Look> = {
  paid: { badge: 'spinner', surface: 'bg-card' },
  queued: { badge: 'spinner', surface: 'bg-card' },
  processing: { badge: 'spinner', surface: 'bg-card' },
  delivered: { badge: 'pop', surface: 'bg-success-soft' },
  voucher: { badge: 'pop', surface: 'bg-success-soft' },
  review: {
    badge: { icon: ScanSearch, bg: 'bg-warning-soft', fg: 'text-warning-text' },
    surface: 'bg-card',
  },
  failed: { badge: { icon: CircleX, bg: 'bg-danger-soft', fg: 'text-danger' }, surface: 'bg-card' },
  refunded: {
    badge: { icon: Undo2, bg: 'bg-info-soft', fg: 'text-info-text' },
    surface: 'bg-card',
  },
  cancelled: {
    badge: { icon: Ban, bg: 'bg-muted', fg: 'text-foreground-secondary' },
    surface: 'bg-card',
  },
};

export interface OrderHeroProps {
  kind: HeroKind;
  title: string;
  body: string;
  /** Confetti (or its still stand-in) over the card. */
  decoration?: ReactNode;
  /** A short "why" pill under the text, when the server gave one. */
  reason?: string;
  /** `row`: from 768 px the badge and the text sit side by side, left aligned (web order page). */
  layout?: 'center' | 'row';
}

/** The big status card of the order page (Checkout.dc.html `order` hero). */
export function OrderHero({
  kind,
  title,
  body,
  decoration,
  reason,
  layout = 'center',
}: OrderHeroProps) {
  const reduced = useReducedMotion();
  const row = layout === 'row';
  const look = LOOKS[kind];
  return (
    <section
      role="status"
      aria-live="polite"
      data-hero={kind}
      className={cn(
        // overflow-hidden keeps the pulse halo (it grows to 1.9x the badge) inside the card.
        'relative flex flex-col items-center gap-2.5 overflow-hidden rounded-[24px] border border-border px-5 py-6 text-center',
        row && 'md:flex-row md:gap-5 md:p-6 md:text-left',
        look.surface,
      )}
    >
      {decoration}
      {look.badge === 'spinner' ? (
        <span className="relative grid size-[72px] place-items-center">
          <span
            aria-hidden="true"
            className="absolute inset-0 animate-[gg-pulse_1400ms_var(--ease-out)_infinite] rounded-full bg-info"
          />
          <span className="relative grid size-[72px] place-items-center rounded-full bg-info text-card">
            <Spinner size={32} />
          </span>
        </span>
      ) : look.badge === 'pop' ? (
        <motion.span
          aria-hidden="true"
          initial={reduced ? false : { scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={SPRING.success}
          className="grid size-[72px] place-items-center rounded-full bg-success text-card"
        >
          <Icon icon={Check} size={34} />
        </motion.span>
      ) : (
        <span
          aria-hidden="true"
          className={`grid size-[72px] place-items-center rounded-full ${look.badge.bg} ${look.badge.fg}`}
        >
          <Icon icon={look.badge.icon} size={32} />
        </span>
      )}
      <div
        className={cn(
          'flex flex-col items-center gap-2.5',
          row && 'md:items-start md:gap-1.5',
          // Success moment: the text rises 200 ms after the check pops; `motion-reduce:animate-none` (and the data-reduced rule) switch it off.
          look.badge === 'pop' &&
            'animate-[gg-float-in_var(--dur-slow)_var(--ease-out)_200ms_both] motion-reduce:animate-none',
        )}
      >
        <h1
          className={cn(
            'mt-1 mb-0 text-2xl leading-[30px] font-extrabold tracking-[-.02em]',
            row && 'md:mt-0 md:text-[28px] md:leading-[34px]',
          )}
        >
          {title}
        </h1>
        <p
          className={cn(
            'm-0 max-w-[300px] text-[15px] leading-[22px] font-medium text-pretty text-foreground-secondary tabular-nums',
            row && 'md:max-w-none md:text-base md:leading-6',
          )}
        >
          {body}
        </p>
        {reason ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs leading-4 font-bold text-foreground-secondary">
            <Icon icon={Info} size={13} />
            {reason}
          </span>
        ) : null}
      </div>
    </section>
  );
}
