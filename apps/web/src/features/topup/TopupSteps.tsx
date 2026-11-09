'use client';

import { useTranslations } from 'next-intl';

/** "1 Summa - 2 To'lov" (PayPage.dc.html, the store modal's header): where the visitor is. */
export function TopupSteps({ current }: { current: 0 | 1 }) {
  const t = useTranslations('store.topup');
  const steps = [t('steps.amount'), t('steps.pay')];
  return (
    <ol
      aria-label={t('steps.label')}
      className="m-0 flex list-none items-center gap-2 p-0 text-[13px] font-bold"
    >
      {steps.map((label, index) => {
        const on = index === current;
        return (
          <li
            key={label}
            aria-current={on ? 'step' : undefined}
            className={`flex items-center gap-1.5 ${on ? 'text-foreground' : 'text-foreground-muted'}`}
          >
            <span
              aria-hidden="true"
              className={`grid size-6 place-items-center rounded-full text-xs font-extrabold ${
                on ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground-muted'
              }`}
            >
              {index + 1}
            </span>
            {label}
            {index === 0 ? (
              <span aria-hidden="true" className="ml-0.5 h-0.5 w-6 rounded-[1px] bg-border" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
