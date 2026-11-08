'use client';

import { Icon, Spinner, useReducedMotion } from '@repo/ui';
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
}

/** The big status card of the order page (Checkout.dc.html `order` hero). */
export function OrderHero({ kind, title, body, decoration, reason }: OrderHeroProps) {
  const reduced = useReducedMotion();
  const look = LOOKS[kind];
  return (
    <section
      role="status"
      aria-live="polite"
      data-hero={kind}
      className={`relative flex flex-col items-center gap-2.5 overflow-hidden rounded-[24px] border border-border px-5 py-6 text-center ${look.surface}`}
    >
      {decoration}
      {look.badge === 'spinner' ? (
        <span className="relative grid size-[72px] place-items-center">
          <span
            aria-hidden="true"
            className="absolute inset-0 animate-[gg-pulse_1600ms_var(--ease-out)_infinite] rounded-full bg-info"
          />
          <span className="relative grid size-[72px] place-items-center rounded-full bg-info text-white">
            <Spinner size={32} />
          </span>
        </span>
      ) : look.badge === 'pop' ? (
        <motion.span
          aria-hidden="true"
          initial={reduced ? false : { scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 380, damping: 18 }}
          className="grid size-[72px] place-items-center rounded-full bg-success text-white"
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
      <h1 className="mt-1 mb-0 text-2xl leading-[30px] font-extrabold tracking-[-.02em]">
        {title}
      </h1>
      <p className="m-0 max-w-[300px] text-[15px] leading-[22px] font-medium text-pretty text-foreground-secondary tabular-nums">
        {body}
      </p>
      {reason ? (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs leading-4 font-bold text-foreground-secondary">
          <Icon icon={Info} size={13} />
          {reason}
        </span>
      ) : null}
    </section>
  );
}
