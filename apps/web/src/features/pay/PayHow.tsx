'use client';

import { useTranslations } from 'next-intl';

const STEPS = ['one', 'two', 'three', 'four'] as const;

/** "Qanday to'lash kerak": the four numbered steps (PayPage.dc.html). */
export function PayHow() {
  const t = useTranslations('pay');
  return (
    <section className="flex flex-col gap-3 rounded-[20px] border border-border bg-card p-4">
      <h2 className="m-0 text-base leading-[22px] font-extrabold">{t('howTitle')}</h2>
      <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
        {STEPS.map((step, index) => (
          <li key={step} className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="grid size-[26px] shrink-0 place-items-center rounded-full bg-primary-soft text-[13px] font-extrabold text-primary-soft-foreground"
            >
              {index + 1}
            </span>
            <span className="pt-[3px] text-sm leading-5 font-semibold text-pretty">
              {t(`steps.${step}`)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
