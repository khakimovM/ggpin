'use client';

import { BRAND } from '@repo/shared';
import { Logo } from '@repo/ui';
import { useTranslations } from 'next-intl';

// MiniApp.dc.html `screen: splash`: the mark breathes (gg-breathe), a 132 x 4 bar runs (gg-indet).
// tokens.css switches both animations off under reduced motion; the bar then rests at 75%.
export function Splash() {
  const t = useTranslations('tg.splash');
  return (
    <main
      aria-busy="true"
      className="flex min-h-dvh flex-col items-center justify-center gap-7 bg-background pt-[var(--tg-safe-top,0px)] pb-20 text-foreground"
    >
      <Logo
        name={BRAND.name}
        size={96}
        className="shadow-glow animate-[gg-breathe_2400ms_ease-in-out_infinite]"
      />
      <Logo name={BRAND.name} variant="wordmark" size={26} />
      <div className="flex flex-col items-center gap-3">
        <span
          role="progressbar"
          aria-label={t('label')}
          className="relative block h-1 w-[132px] overflow-hidden rounded-[2px] bg-muted"
        >
          <span className="absolute inset-y-0 left-0 w-2/5 rounded-[2px] bg-primary animate-[gg-indet_1300ms_var(--ease-standard)_infinite] motion-reduce:translate-x-[75%] [[data-reduced=true]_&]:translate-x-[75%]" />
        </span>
        <p className="m-0 text-[13px] leading-[18px] font-semibold text-foreground-muted">
          {t('signingIn')}
        </p>
      </div>
    </main>
  );
}
