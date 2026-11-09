'use client';

import { ErrorState, Skeleton, cn } from '@repo/ui';
import { useLocale, useTranslations } from 'next-intl';
import { formatTiyinString } from '../../lib/format/tiyin';
import { MONEY_PLACEHOLDER } from '../../lib/format/money';
import { useWallet } from '../wallet/use-wallet';

const DIGITS = /^[0-9]{1,19}$/;

/** A count with the locale's digit grouping; BigInt keeps a large string exact (no `Number`). */
function formatCount(value: string, locale: 'uz' | 'ru'): string {
  return DIGITS.test(value) ? new Intl.NumberFormat(locale).format(BigInt(value)) : value;
}

/**
 * Balans and Keshbek tiles of the profile card (Account.dc.html). Both numbers are the server's
 * `GET /me/wallet`; nothing is added or subtracted here. The wallet card on the home page and this
 * one share the query, so opening the profile does not ask twice.
 */
export function WalletTiles({ variant }: { variant: 'tg' | 'web' }) {
  const t = useTranslations('account.profile');
  const common = useTranslations('common');
  const locale = useLocale() === 'ru' ? 'ru' : 'uz';
  const wallet = useWallet();
  const web = variant === 'web';

  if (wallet.isPending) {
    return (
      <div aria-busy="true" className="grid grid-cols-2 gap-2">
        <Skeleton className={cn('rounded-2xl', web ? 'h-[76px]' : 'h-[72px]')} />
        <Skeleton className={cn('rounded-2xl', web ? 'h-[76px]' : 'h-[72px]')} />
      </div>
    );
  }
  if (wallet.isError) {
    return (
      <ErrorState
        framed={false}
        title={t('walletError')}
        retryLabel={common('retry')}
        retrying={wallet.isFetching}
        onRetry={() => void wallet.refetch()}
      />
    );
  }
  const balance = formatTiyinString(wallet.data.balanceTiyin, locale) ?? MONEY_PLACEHOLDER;
  const value = cn(
    'font-display font-semibold tracking-[-.03em] whitespace-nowrap tabular-nums',
    web ? 'text-[19px] leading-6' : 'text-[17px] leading-[22px]',
  );
  return (
    <div className={cn('grid grid-cols-2', web ? 'gap-2.5' : 'gap-2')}>
      <div
        className={cn(
          'flex flex-col gap-1 rounded-2xl bg-primary text-primary-foreground',
          web ? 'p-3.5' : 'p-3',
        )}
      >
        <span className="text-xs leading-4 font-bold">{t('balance')}</span>
        <span className={value}>
          {balance}{' '}
          <span className="font-sans text-xs leading-none font-bold">{common('currency.uzs')}</span>
        </span>
      </div>
      <div className={cn('flex flex-col gap-1 rounded-2xl bg-accent-soft', web ? 'p-3.5' : 'p-3')}>
        <span className="text-xs leading-4 font-bold text-accent-soft-foreground">
          {t('cashback')}
        </span>
        <span
          role="img"
          aria-label={t('coinsLabel', { count: Number(wallet.data.coins) })}
          className={cn(value, 'text-foreground')}
        >
          <span aria-hidden="true">{formatCount(wallet.data.coins, locale)} 🪙</span>
        </span>
      </div>
    </div>
  );
}
