import type { Locale } from '@repo/shared';
import { cn, Icon } from '@repo/ui';
import {
  Activity,
  ArrowRight,
  AtSign,
  Check,
  CircleCheck,
  LoaderCircle,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import {
  LANDING_ANCHOR,
  LANDING_CONTAINER,
  LANDING_H2,
  LANDING_LEAD,
  LANDING_SECTION_Y,
} from './landing-styles';
import { PayMethodsStrip } from './PayMethodsStrip';

const STEP_CARD = 'flex flex-col gap-4 rounded-3xl border border-border bg-card p-6';
const STEP_TITLE = 'm-0 text-[19px] leading-[25px] font-extrabold';
const CHIP =
  'h-[30px] rounded-full bg-muted px-2.5 text-xs leading-[30px] font-bold text-foreground-secondary';

function StepHead({ index, icon }: { index: number; icon: LucideIcon }) {
  return (
    <span className="flex items-center justify-between">
      <span className="font-display text-[32px] leading-none font-bold tracking-[-.04em] text-primary">
        {String(index).padStart(2, '0')}
      </span>
      <span
        aria-hidden="true"
        className="grid size-11 place-items-center rounded-[14px] bg-primary-soft text-primary-soft-foreground"
      >
        <Icon icon={icon} size={20} />
      </span>
    </span>
  );
}

/**
 * Site.dc.html `#qanday-ishlaydi`: three steps and, below them, the payment methods (Humo and
 * Uzcard, as text: no bank logos). The small pictures inside the steps are illustrations of the
 * product (a username field, an order status) and are hidden from assistive technology.
 */
export async function HowItWorks({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: 'site.how' });

  return (
    <section
      id="how-it-works"
      aria-labelledby="how-title"
      className={cn(LANDING_ANCHOR, LANDING_SECTION_Y, 'border-y border-border bg-surface')}
    >
      <div className={cn(LANDING_CONTAINER, 'flex flex-col gap-8')}>
        <div className="flex flex-col gap-2">
          <h2 id="how-title" className={LANDING_H2}>
            {t('title')}
          </h2>
          <p className={LANDING_LEAD}>{t('lead')}</p>
        </div>
        {/* One column on phones, three from lg (as before). In between (md) two cards on top and the
            third below at full width (owner decision, p8 S6): auto-fit left it alone at half width. */}
        <ol className="m-0 grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-2 lg:grid-cols-3">
          <li className={STEP_CARD}>
            <StepHead index={1} icon={Wallet} />
            <h3 className={STEP_TITLE}>{t('steps.s1')}</h3>
            <span className="flex flex-wrap gap-1.5">
              <span className={CHIP}>{t('methods.humo')}</span>
              <span className={CHIP}>{t('methods.uzcard')}</span>
              <span className={CHIP}>{t('anyBank')}</span>
            </span>
          </li>
          <li className={STEP_CARD}>
            <StepHead index={2} icon={AtSign} />
            <h3 className={STEP_TITLE}>{t('steps.s2')}</h3>
            <span
              aria-hidden="true"
              className="flex h-11 items-center gap-2 rounded-control border-[1.5px] border-input-border bg-input pr-1.5 pl-3 text-sm leading-none font-semibold"
            >
              <span className="text-foreground-muted">@</span>
              {t('mock.handle')}
              <span className="ml-auto inline-flex h-[30px] items-center gap-1 rounded-[9px] bg-success-soft px-2.5 text-xs leading-none font-extrabold text-success-text">
                <Icon icon={Check} size={13} />
                {t('mock.name')}
              </span>
            </span>
          </li>
          <li className={cn(STEP_CARD, 'md:col-span-2 lg:col-span-1')}>
            <StepHead index={3} icon={Activity} />
            <h3 className={STEP_TITLE}>{t('steps.s3')}</h3>
            <span aria-hidden="true" className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex h-7 items-center gap-[5px] rounded-full bg-status-processing-soft px-2.5 text-xs leading-none font-bold text-status-processing">
                <Icon
                  icon={LoaderCircle}
                  size={13}
                  className="animate-[gg-spin_900ms_linear_infinite] motion-reduce:animate-none"
                />
                {t('status.processing')}
              </span>
              <Icon icon={ArrowRight} size={14} className="text-foreground-muted" />
              <span className="inline-flex h-7 items-center gap-[5px] rounded-full bg-status-delivered-soft px-2.5 text-xs leading-none font-bold text-status-delivered">
                <Icon icon={CircleCheck} size={13} />
                {t('status.delivered')}
              </span>
            </span>
          </li>
        </ol>
        <PayMethodsStrip locale={locale} />
      </div>
    </section>
  );
}
