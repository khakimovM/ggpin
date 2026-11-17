import { cn } from '@repo/ui';
import { useTranslations } from 'use-intl';
import type { EnvLabel } from '../../env-schema';

const TONE: Record<EnvLabel, string> = {
  // AA at 11px: the darker danger fill on light, dark text on dark (as Button `danger`).
  PRODUCTION: 'bg-danger-hover text-danger-foreground dark:bg-danger dark:text-background',
  STAGING: 'bg-warning text-accent-foreground',
  DEV: 'bg-muted text-foreground-secondary',
};

/** Which environment this panel talks to (Admin.dc.html `env`): red on production, amber on staging. */
export function EnvBadge({ label, className }: { label: EnvLabel; className?: string }) {
  const t = useTranslations();
  return (
    <span
      className={cn(
        'inline-flex h-[26px] flex-none items-center rounded-[7px] px-2.5 text-[11px] leading-none font-extrabold tracking-[.06em]',
        TONE[label],
        className,
      )}
    >
      {t(`admin.env.${label}`)}
    </span>
  );
}
