import { Info } from 'lucide-react';
import { useTranslations } from 'use-intl';

/**
 * Says that the screen's endpoint arrives in phase 9-B (orders, hot wallet, Fragment): on the dev
 * server the data is the mock's, and a production build shows the API's answer (a 404 until then).
 */
export function MockNote() {
  const t = useTranslations();
  return (
    <p className="m-0 flex items-center gap-2 rounded-[10px] bg-info-soft px-3 py-2 text-xs leading-4 font-semibold text-info-text">
      <Info size={14} aria-hidden="true" />
      {t('admin.states.apiLater')}
    </p>
  );
}
