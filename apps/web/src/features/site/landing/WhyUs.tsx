import type { Locale } from '@repo/shared';
import { cn, Icon } from '@repo/ui';
import { Eye, MessagesSquare, ShieldCheck, Zap, type LucideIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { LANDING_CONTAINER, LANDING_H2, LANDING_SECTION_Y } from './landing-styles';

// The four reasons, with the tint of each icon from the design (Site.dc.html "Nega biz?").
const REASONS: readonly {
  key: 'auto' | 'status' | 'refund' | 'support';
  icon: LucideIcon;
  tint: string;
}[] = [
  { key: 'auto', icon: Zap, tint: 'bg-success-soft text-success' },
  { key: 'status', icon: Eye, tint: 'bg-info-soft text-info' },
  { key: 'refund', icon: ShieldCheck, tint: 'bg-primary-soft text-primary-soft-foreground' },
  { key: 'support', icon: MessagesSquare, tint: 'bg-accent-soft text-accent-soft-foreground' },
];

export async function WhyUs({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: 'site.why' });

  return (
    <section aria-labelledby="why-title" className={LANDING_SECTION_Y}>
      <div className={cn(LANDING_CONTAINER, 'flex flex-col gap-8')}>
        <h2 id="why-title" className={LANDING_H2}>
          {t('title')}
        </h2>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,250px),1fr))] gap-4">
          {REASONS.map(({ key, icon, tint }) => (
            <article
              key={key}
              className="flex flex-col gap-3 rounded-3xl border border-border bg-card p-6"
            >
              <span
                aria-hidden="true"
                className={cn('grid size-12 place-items-center rounded-[14px]', tint)}
              >
                <Icon icon={icon} size={22} />
              </span>
              <h3 className="mx-0 mt-1 mb-0 text-lg leading-6 font-extrabold">
                {t(`items.${key}.title`)}
              </h3>
              <p className="m-0 text-[15px] leading-[22px] font-medium text-foreground-secondary">
                {t(`items.${key}.text`)}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
