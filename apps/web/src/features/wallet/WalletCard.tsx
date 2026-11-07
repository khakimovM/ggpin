'use client';

import { Badge, ErrorState, Icon, Skeleton } from '@repo/ui';
import { Plus, Ticket } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { AnimatedMoney } from './AnimatedMoney';
import { HelpAction } from './HelpAction';
import { useWallet } from './use-wallet';

const BLOB =
  'pointer-events-none absolute -z-10 rounded-full animate-[gg-drift_9s_ease-in-out_infinite]';
const ON_PRIMARY_BUTTON =
  'bg-[color-mix(in_oklab,var(--primary-foreground)_16%,transparent)] text-primary-foreground';

/**
 * The wallet card of the Mini App home (MiniApp.dc.html `home`). The balance is the server's
 * `GET /me/wallet`, never computed here. "To‘ldirish" and "Bonus kod" are shown but not pressable
 * ("Tez orada") until the top-up (phase 7 S8) and bonus-code screens exist; "Yordam" is the
 * support link (see HelpAction).
 */
export function WalletCard() {
  const t = useTranslations('wallet.card');
  const common = useTranslations('common');
  const wallet = useWallet();

  if (wallet.isPending) {
    return (
      <div aria-busy="true">
        <span className="sr-only" role="status">
          {t('loading')}
        </span>
        <Skeleton className="h-[208px] rounded-[28px]" />
      </div>
    );
  }
  if (wallet.isError) {
    return (
      <ErrorState
        title={t('error.title')}
        retryLabel={common('retry')}
        retrying={wallet.isFetching}
        onRetry={() => void wallet.refetch()}
        className="rounded-[28px]"
      />
    );
  }

  return (
    <section
      aria-label={t('label')}
      className="relative isolate flex flex-col gap-[18px] overflow-hidden rounded-[28px] bg-primary p-5 text-primary-foreground shadow-glow"
    >
      <span
        aria-hidden="true"
        className={`${BLOB} -top-[120px] -right-[90px] size-[260px] bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--primary-foreground)_26%,transparent),transparent)]`}
      />
      <span
        aria-hidden="true"
        className={`${BLOB} -bottom-[120px] -left-20 size-[220px] bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--accent)_45%,transparent),transparent)] [animation-duration:11s] [animation-delay:1.5s]`}
      />
      <span
        aria-hidden="true"
        className={`${BLOB} -bottom-[70px] right-10 size-[140px] bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--premium)_55%,transparent),transparent)] [animation-duration:13s] [animation-delay:3s]`}
      />
      <span className="flex items-center justify-between">
        <span className="text-sm leading-[18px] font-bold">{t('balance')}</span>
        <span
          aria-hidden="true"
          className="font-display text-sm leading-none font-extrabold tracking-[-.12em] opacity-50"
        >
          g<span className="text-accent">g</span>
        </span>
      </span>
      <span className="flex items-baseline gap-2 tabular-nums" data-testid="wallet-balance">
        <AnimatedMoney
          tiyin={wallet.data.balanceTiyin}
          className="font-display text-[40px] leading-[44px] font-semibold tracking-[-.035em]"
        />
        <span className="text-[17px] leading-[22px] font-bold">{common('currency.uzs')}</span>
      </span>
      <div className="flex flex-col gap-2">
        <button
          type="button"
          aria-disabled="true"
          className="flex h-12 cursor-not-allowed items-center justify-center gap-2 rounded-[14px] bg-primary-foreground text-[15px] font-extrabold text-primary"
        >
          <Icon icon={Plus} size={18} />
          {t('topUp')}
          <Badge size="sm">{t('soon')}</Badge>
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            aria-disabled="true"
            className={`relative flex h-11 cursor-not-allowed items-center justify-center gap-1.5 rounded-[14px] text-sm font-extrabold whitespace-nowrap ${ON_PRIMARY_BUTTON}`}
          >
            <Icon icon={Ticket} size={16} />
            {t('bonus')}
            <Badge size="sm" variant="soon" className="absolute -top-2 right-2">
              {t('soon')}
            </Badge>
          </button>
          <HelpAction className={ON_PRIMARY_BUTTON} />
        </div>
      </div>
    </section>
  );
}
