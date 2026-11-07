'use client';

import { DURATION, EASE, Icon } from '@repo/ui';
import { motion } from 'motion/react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export type GateTone = 'primary' | 'danger' | 'warning';

const TONES: Record<GateTone, string> = {
  primary: 'bg-primary-soft text-primary-soft-foreground',
  danger: 'bg-danger-soft text-danger',
  warning: 'bg-warning-soft text-warning-text',
};

interface GateScreenProps {
  icon: LucideIcon;
  tone: GateTone;
  title: string;
  body: string;
  /** The one button at the bottom; a gate may have none. */
  action?: ReactNode;
}

/**
 * MiniApp.dc.html `screen: gate-*`: a centred 88px icon disc, a 24/30 title, a 16/24 body capped at
 * 300px, and one full-width 52px button pinned to the bottom (34px above the edge, plus the safe
 * area). The icon, title and body are announced together as the page heading and description.
 */
export function GateScreen({ icon, tone, title, body, action }: GateScreenProps) {
  return (
    <motion.main
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.base, ease: EASE.out }}
      className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col bg-background px-6 pt-[var(--tg-safe-top,0px)] text-foreground"
    >
      <div className="flex flex-1 flex-col items-center justify-center gap-4 pb-6 text-center">
        <span
          aria-hidden="true"
          className={`mb-2 grid size-22 place-items-center rounded-full ${TONES[tone]}`}
        >
          <Icon icon={icon} size={40} />
        </span>
        <h1 className="m-0 text-2xl leading-[30px] font-extrabold tracking-[-.02em] text-balance">
          {title}
        </h1>
        <p className="m-0 max-w-[300px] text-base leading-6 font-medium text-pretty text-foreground-secondary">
          {body}
        </p>
      </div>
      {action ? (
        <div className="pt-3 pb-[calc(34px+var(--tg-safe-bottom,0px))]">{action}</div>
      ) : null}
    </motion.main>
  );
}
