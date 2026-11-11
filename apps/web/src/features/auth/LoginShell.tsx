import { BRAND } from '@repo/shared';
import { HIT_AREA_LINK, Icon, Logo } from '@repo/ui';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';

interface Props {
  homeHref: string;
  homeLabel: string;
  backLabel: string;
  title: string;
  subtitle: string;
  securityNote: string;
  children: ReactNode;
}

/**
 * The frame of Login.dc.html (`variant: user`): header with the logo and a way back, the glow,
 * and the card with the brand mark, title, the step content and the "never share the code" note.
 * No state and no i18n hooks, so the login page can render it on the server.
 */
export function LoginShell({
  homeHref,
  homeLabel,
  backLabel,
  title,
  subtitle,
  securityNote,
  children,
}: Props) {
  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-background text-foreground">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -top-[30%] left-1/2 h-[900px] w-[1100px] -translate-x-1/2 rounded-full"
        style={{ background: 'radial-gradient(closest-side, var(--primary-soft), transparent)' }}
      />
      <header className="relative mx-auto flex h-16 w-full max-w-[1264px] items-center justify-between gap-4 px-4 md:h-[72px] md:px-8">
        <a
          href={homeHref}
          aria-label={homeLabel}
          className={`relative flex items-center gap-2.5 rounded-xs text-foreground no-underline ${HIT_AREA_LINK} focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none`}
        >
          {/* The mark is decorative: the link's name starts with the visible wordmark (WCAG 2.5.3). */}
          <Logo variant="mark" size={32} name={BRAND.name} decorative />
          <Logo variant="wordmark" size={20} name={BRAND.name} />
        </a>
        <a
          href={homeHref}
          className="flex h-11 items-center gap-1.5 rounded-control px-3 text-sm font-bold text-foreground-secondary no-underline hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Icon icon={ArrowLeft} size={16} />
          {backLabel}
        </a>
      </header>
      <main className="relative grid flex-1 place-items-center px-4 pt-4 pb-8 md:pt-8 md:pb-16">
        <div className="flex w-[min(100%,440px)] flex-col gap-[22px] rounded-2xl border border-border bg-card px-5 py-6 shadow-lg md:p-9">
          <div className="flex flex-col items-center gap-3.5 text-center">
            <Logo variant="mark" size={56} name={BRAND.name} className="shadow-glow" />
            <h1 className="m-0 text-[26px] leading-8 font-extrabold tracking-[-0.02em]">{title}</h1>
            <p className="m-0 text-[15px] leading-[22px] font-medium text-pretty text-foreground-secondary">
              {subtitle}
            </p>
          </div>
          {children}
          <div className="flex items-start gap-2.5 border-t border-border pt-[18px] text-[13px] leading-[19px] font-semibold text-foreground-secondary">
            <Icon icon={ShieldCheck} size={18} className="mt-px flex-none text-success" />
            {securityNote}
          </div>
        </div>
      </main>
    </div>
  );
}
