import type { Locale } from '@repo/shared';
import { getTranslations } from 'next-intl/server';

/**
 * The payment methods under the steps (Site.dc.html "To‘lov usullari"): Humo and Uzcard, the two
 * cards the wallet is topped up from. The square is the slot for a bank logo (dashed, as in the
 * design); until the logos are licensed it carries the first letter of the name.
 */
export async function PayMethodsStrip({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: 'site.how.methods' });
  const methods = [t('humo'), t('uzcard')];

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-4 pt-2">
      <span className="text-[13px] leading-[18px] font-bold tracking-[.06em] text-foreground-muted uppercase">
        {t('title')}
      </span>
      <ul className="m-0 flex list-none flex-wrap gap-2.5 p-0">
        {methods.map((name) => (
          <li
            key={name}
            className="flex min-h-14 items-center gap-2.5 rounded-2xl border border-border bg-card py-2 pr-[18px] pl-2"
          >
            <span
              aria-hidden="true"
              className="grid size-10 place-items-center rounded-[12px] border border-dashed border-input-border bg-muted text-xs leading-none font-extrabold text-foreground-muted"
            >
              {name.charAt(0)}
            </span>
            <span className="text-[15px] leading-none font-extrabold">{name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
