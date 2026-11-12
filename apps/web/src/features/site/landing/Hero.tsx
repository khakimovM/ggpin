import type { Locale } from '@repo/shared';
import { cn, Icon } from '@repo/ui';
import { ArrowRight, Send, Zap } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { storePath } from '../../../i18n/paths';
import { siteLinks } from '../shell/site-links';
import { HeroFloatCards } from './HeroFloatCards';
import { HeroPhone } from './HeroPhone';
import { LANDING_CTA_PRIMARY, LANDING_CTA_SECONDARY } from './landing-styles';

// The three promises under the buttons: an emoji (decorative) and the sentence.
const TRUST = [
  { key: 'fast', glyph: '⚡' },
  { key: 'secure', glyph: '🔒' },
  { key: 'refund', glyph: '💸' },
] as const;

/**
 * Site.dc.html `page: landing`, `hero: classic`: the badge, the H1, the lead, the two buttons and
 * the three promises on the left; the phone with two floating cards on the right. On a narrow
 * screen the picture goes under the text. The picture is decorative and hidden from assistive
 * technology, and so is the glow behind it.
 */
export async function Hero({ locale }: { locale: Locale }) {
  const [t, cta] = await Promise.all([
    getTranslations({ locale, namespace: 'site.hero' }),
    getTranslations({ locale, namespace: 'site.cta' }),
  ]);
  const { bot } = siteLinks();

  // overflow-x: clip, as the prototype's root has it: the glow behind the phone is wider than a
  // narrow screen and would otherwise scroll the page sideways.
  return (
    <section aria-labelledby="hero-title" className="relative overflow-x-clip">
      <div className="mx-auto grid w-full max-w-[1264px] grid-cols-[repeat(auto-fit,minmax(min(100%,520px),1fr))] items-center gap-[clamp(40px,4vw,64px)] px-[clamp(16px,2.5vw,32px)] pt-[clamp(32px,5vw,72px)] pb-[clamp(48px,6vw,96px)]">
        <div className="flex min-w-0 flex-col gap-6">
          <span className="inline-flex h-8 max-w-full items-center gap-2 self-start rounded-full border border-border bg-card pr-3 pl-1.5 text-[13px] leading-none font-bold whitespace-nowrap text-foreground-secondary">
            <span className="flex h-[22px] flex-none items-center gap-1 rounded-full bg-success-soft px-2 text-[11px] leading-none font-extrabold whitespace-nowrap text-success-text">
              <Icon icon={Zap} size={11} />
              {t('badge')}
            </span>
            {t('channels')}
          </span>
          {/* Hyphenation (Russian only: the browser has no Uzbek dictionary) helps a narrow screen; from
              1024 px the column is wide enough for whole words, and a word split in the middle of the
              headline (до-/наты) reads worse than a ragged line. */}
          <h1
            id="hero-title"
            className="m-0 font-display text-[clamp(30px,3.9vw,56px)] leading-[1.1] font-bold tracking-[-.035em] text-balance hyphens-auto lg:hyphens-manual"
          >
            {t('title')} <span className="text-primary">{t('titleAccent')}</span>
          </h1>
          <p className="m-0 max-w-[540px] text-[clamp(16px,1.3vw,19px)] leading-[1.55] font-medium text-pretty text-foreground-secondary">
            {t('lead')}
          </p>
          <div className="flex flex-wrap gap-3">
            {bot === null ? null : (
              <a
                href={bot}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  LANDING_CTA_PRIMARY,
                  'max-w-[280px] min-w-[min(100%,220px)] flex-[1_1_220px]',
                )}
              >
                <Icon icon={Send} size={18} />
                {cta('telegram')}
              </a>
            )}
            <Link
              href={storePath(locale)}
              prefetch={false}
              className={cn(
                LANDING_CTA_SECONDARY,
                'max-w-[280px] min-w-[min(100%,220px)] flex-[1_1_220px]',
              )}
            >
              {cta('store')}
              <Icon icon={ArrowRight} size={18} />
            </Link>
          </div>
          <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-2 p-0 text-sm leading-5 font-bold text-foreground-secondary">
            {TRUST.map(({ key, glyph }) => (
              <li key={key}>
                <span aria-hidden="true">{glyph} </span>
                {t(`trust.${key}`)}
              </li>
            ))}
          </ul>
        </div>

        <div
          aria-hidden="true"
          className="relative grid h-[clamp(560px,46vw,640px)] w-[min(100%,480px)] place-items-center justify-self-center"
        >
          <span className="absolute aspect-square w-[min(110%,560px)] rounded-full bg-[radial-gradient(closest-side,var(--primary-soft),transparent)] opacity-90" />
          <HeroPhone locale={locale} />
          <HeroFloatCards locale={locale} />
        </div>
      </div>
    </section>
  );
}
