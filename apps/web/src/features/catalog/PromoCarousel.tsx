'use client';

import { HIT_AREA_44, HIT_AREA_44_Y, Icon } from '@repo/ui';
import { ArrowRight, Gift } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';

export interface PromoCarouselProps {
  /** Where "Havolani olish" leads: the profile, which holds the referral link. */
  referralHref: string;
  /** The Premium product page, or null when the catalog has no Premium (its banner is not drawn). */
  giftHref: string | null;
}

interface Slide {
  id: 'referral' | 'gift';
  href: string;
  surface: string;
  button: string;
  glyph: ReactNode;
  glyphSurface: string;
}

/**
 * Store.dc.html catalog banner (web, desktop and tablet): two or three static announcements in a
 * strip that slides (dur-slow, ease-standard) with dots under it. The design's third banner
 * ("Free Fire va Standoff 2 — tez orada", "Xabar olish") is not drawn: there is no notification
 * list to join and it names products the catalog may never get. Only the current slide is
 * reachable by keyboard and screen reader; under reduced motion the strip simply jumps.
 *
 * The strip never turns by itself, only by the dots (owner decision 2026-11-09, WCAG 2.2.2: moving
 * content that starts on its own needs a pause control, and a manual strip needs none).
 */
export function PromoCarousel({ referralHref, giftHref }: PromoCarouselProps) {
  const t = useTranslations('store.catalog.promo');
  const [index, setIndex] = useState(0);
  const slides: Slide[] = [
    {
      id: 'referral',
      href: referralHref,
      surface: 'bg-primary text-primary-foreground',
      button: 'bg-primary-foreground text-primary',
      glyph: (
        <span className="font-display text-[44px] leading-none font-bold tracking-[-.04em]">
          1%
        </span>
      ),
      glyphSurface: 'bg-accent text-accent-foreground',
    },
    ...(giftHref === null
      ? []
      : [
          {
            id: 'gift' as const,
            href: giftHref,
            // White on --premium passes contrast in the light theme only (the dark --premium is pale).
            surface: 'bg-premium text-white dark:text-background',
            button: 'bg-white text-premium dark:bg-background dark:text-premium',
            glyph: <Icon icon={Gift} size={60} />,
            glyphSurface: 'bg-white/18 text-white dark:bg-background/18 dark:text-background',
          },
        ]),
  ];
  const current = Math.min(index, slides.length - 1);

  return (
    <section
      aria-roledescription={t('roleCarousel')}
      aria-label={t('label')}
      className="hidden flex-col gap-2.5 md:flex"
      data-testid="promo"
    >
      <div className="overflow-hidden rounded-[24px]">
        <div
          className="flex transition-transform duration-slow ease-standard"
          style={{
            width: `${slides.length * 100}%`,
            transform: `translateX(-${(current * 100) / slides.length}%)`,
          }}
        >
          {slides.map((slide, position) => (
            <div
              key={slide.id}
              role="group"
              data-slide=""
              aria-roledescription={t('roleSlide')}
              aria-label={t('slide', { number: position + 1 })}
              aria-hidden={position === current ? undefined : true}
              inert={position === current ? undefined : true}
              style={{ width: `${100 / slides.length}%` }}
              className={`relative flex h-[200px] flex-col justify-center gap-2.5 overflow-hidden px-6 py-7 lg:h-[220px] lg:px-8 ${slide.surface}`}
            >
              <span className="relative z-10 max-w-[420px] font-display text-[22px] leading-[1.2] font-bold tracking-[-.03em] text-balance lg:max-w-[520px] lg:text-[26px]">
                {t(`${slide.id}.title`)}
              </span>
              <span className="relative z-10 max-w-[440px] text-[15px] leading-[22px] font-semibold">
                {t(`${slide.id}.sub`)}
              </span>
              <Link
                href={slide.href}
                className={`relative z-10 mt-1.5 flex h-10 items-center gap-1.5 self-start rounded-xl px-4 text-sm font-extrabold no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current ${HIT_AREA_44} ${slide.button}`}
              >
                {t(`${slide.id}.cta`)}
                <Icon icon={ArrowRight} size={15} />
              </Link>
              <span
                aria-hidden="true"
                className={`absolute top-1/2 right-10 hidden size-[150px] -translate-y-1/2 -rotate-[10deg] place-items-center rounded-full md:grid ${slide.glyphSurface}`}
              >
                {slide.glyph}
              </span>
            </div>
          ))}
        </div>
      </div>
      {slides.length > 1 ? (
        <div className="flex justify-center gap-0.5">
          {slides.map((slide, position) => (
            <button
              key={slide.id}
              type="button"
              aria-label={t('slide', { number: position + 1 })}
              aria-current={position === current ? 'true' : undefined}
              onClick={() => setIndex(position)}
              data-hit="y"
              className={`relative grid h-6 w-6 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-ring ${HIT_AREA_44_Y}`}
            >
              <span
                className={`h-1.5 rounded-[3px] transition-[width] duration-base ${position === current ? 'w-5 bg-primary' : 'w-1.5 bg-input-border'}`}
              />
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
