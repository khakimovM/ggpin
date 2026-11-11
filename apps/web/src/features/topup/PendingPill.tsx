'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useFormatMoney } from '../../lib/format/money';
import { WaitingDot } from '../pay/WaitingDot';
import { mmss } from '../pay/PayCountdown';
import { useCountdown } from '../auth/use-countdown';
import { usePendingIntent } from './use-intent-status';

/**
 * "To'lov kutilmoqda · 21:05" (TopupMini.dc.html `home`): a small pill on the home screen while a
 * top-up waits for money. It leads back to the waiting screen. Nothing is drawn without a waiting
 * request, while it loads, or when the lookup fails: the pill is a shortcut, never a blocker.
 */
export function PendingPill() {
  const t = useTranslations('tg.topup');
  const formatMoney = useFormatMoney();
  const pending = usePendingIntent();
  const intent = pending.data ?? null;
  const msLeft = useCountdown(
    intent === null ? null : Date.parse(intent.expiresAt),
    pending.dataUpdatedAt,
  );
  if (intent === null || msLeft <= 0) return null;
  return (
    <Link
      href={`/tg/topup/${intent.intentId}`}
      data-testid="topup-pill"
      className="flex h-11 items-center gap-2.5 self-start rounded-full bg-info-soft px-4 text-sm font-extrabold text-info-text tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <WaitingDot />
      {t('pill', { amount: formatMoney(intent.payAmountTiyin), time: mmss(msLeft) })}
    </Link>
  );
}
