import type { Locale } from '@repo/shared';
import { Icon } from '@repo/ui';
import { CircleCheck, Crown, LoaderCircle } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

// Both cards: they float in one after the other (gg-float-in), then bob for good (gg-bob). The
// tokens' reduced-motion rules and `data-reduced` stop the animation; `motion-reduce:animate-none`
// also removes the entrance delay, so under reduced motion the cards are simply there.
const CARD =
  'flex items-center gap-2.5 rounded-2xl border border-border bg-elevated py-2.5 pr-3.5 pl-2.5 shadow-lg';

/**
 * The two floating cards of the classic hero (Stars delivered, Premium in progress). Decorative:
 * the caller hides them from assistive technology. They carry no price (phase 8 plan, P8-Q5) and
 * the username is a template, not a real person.
 */
export async function HeroFloatCards({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: 'site.hero.mock' });

  return (
    <>
      <div className="absolute top-[13%] left-0 animate-[gg-float-in_var(--dur-slower)_var(--ease-out)_300ms_both] motion-reduce:animate-none">
        <div
          className={`${CARD} animate-[gg-bob_6s_ease-in-out_1s_infinite] motion-reduce:animate-none`}
        >
          <span className="grid size-[34px] place-items-center rounded-full bg-success-soft text-success">
            <Icon icon={CircleCheck} size={17} />
          </span>
          <span className="flex flex-col gap-0.5">
            <span className="text-sm leading-[18px] font-extrabold">{t('delivered')}</span>
            <span className="text-[11px] leading-3.5 font-semibold text-foreground-muted">
              {t('deliveredMeta')}
            </span>
          </span>
        </div>
      </div>
      <div className="absolute top-[47%] right-0 animate-[gg-float-in_var(--dur-slower)_var(--ease-out)_650ms_both] motion-reduce:animate-none">
        <div
          className={`${CARD} animate-[gg-bob_7s_ease-in-out_1.4s_infinite] motion-reduce:animate-none`}
        >
          <span className="grid size-[34px] place-items-center rounded-full bg-premium-soft text-premium">
            <Icon icon={Crown} size={16} />
          </span>
          <span className="flex flex-col gap-[3px]">
            <span className="text-sm leading-[18px] font-extrabold">{t('premium')}</span>
            <span className="inline-flex items-center gap-1 text-[11px] leading-3.5 font-bold text-status-processing">
              <Icon
                icon={LoaderCircle}
                size={12}
                className="animate-[gg-spin_900ms_linear_infinite] motion-reduce:animate-none"
              />
              {t('processing')}
            </span>
          </span>
        </div>
      </div>
    </>
  );
}
