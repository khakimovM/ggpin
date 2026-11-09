'use client';

import { Icon, Switch, useTheme } from '@repo/ui';
import { ZapOff } from 'lucide-react';
import { useId } from 'react';
import { useTranslations } from 'next-intl';

/**
 * "Animatsiyalarni kamaytirish" (Account.dc.html `rmOn`). The ThemeProvider owns the setting: it
 * keeps it in localStorage (a UI preference, not a token), sets `data-reduced` on <html> and tells
 * Framer Motion, so CSS and JS animation both stop. The inline theme script applies it before the
 * first paint.
 */
export function ReducedMotionSwitch() {
  const t = useTranslations('account.profile.settings.reducedMotion');
  const { reducedMotion, setReducedMotion } = useTheme();
  const labelId = useId();
  return (
    <div className="flex min-h-16 items-center gap-3 rounded-[20px] border border-border bg-card px-4 py-2.5">
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-foreground-secondary"
      >
        <Icon icon={ZapOff} size={18} />
      </span>
      <span id={labelId} className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[15px] leading-5 font-extrabold">{t('label')}</span>
        <span className="text-xs leading-4 font-semibold text-foreground-muted">{t('hint')}</span>
      </span>
      <Switch checked={reducedMotion} onCheckedChange={setReducedMotion} label={t('label')} />
    </div>
  );
}
