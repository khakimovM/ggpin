import { cn } from '@repo/ui';
import type { ReactNode } from 'react';

export type TagTone = 'ok' | 'warn' | 'bad' | 'info' | 'mute' | 'prem';

const TONE: Record<TagTone, string> = {
  ok: 'bg-success-soft text-success-text',
  warn: 'bg-warning-soft text-warning-text',
  bad: 'bg-danger-soft text-danger-text',
  info: 'bg-info-soft text-info-text',
  mute: 'bg-muted text-foreground-secondary',
  prem: 'bg-premium-soft text-premium-text',
};

/** The small status chip of the admin tables (Admin.dc.html `tag`: 20px, 10px extrabold). */
export function Tag({ tone, children }: { tone: TagTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-[6px] px-[7px] text-[10px] leading-none font-extrabold tracking-[.02em] whitespace-nowrap',
        TONE[tone],
      )}
    >
      {children}
    </span>
  );
}
