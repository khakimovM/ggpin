'use client';

import type { TopupIntent } from '@repo/shared';
import { Button, EmptyState, ErrorState, Icon, Skeleton } from '@repo/ui';
import { Check, CircleX, ExternalLink, TimerOff, WalletCards } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { isApiError } from '../../lib/api/errors';
import { Money, useFormatMoney } from '../../lib/format/money';
import { haptics } from '../../telegram/haptics';
import { useCountdown } from '../auth/use-countdown';
import { SuccessBurst } from '../order/SuccessBurst';
import { WaitingDot } from '../pay/WaitingDot';
import { mmss } from '../pay/PayCountdown';
import { SupportLinkButton } from '../support/SupportLinkButton';
import { useWallet } from '../wallet/use-wallet';
import { CancelDialog } from './CancelDialog';
import { CountdownRing } from './CountdownRing';
import { TopupNotes } from './TopupNotes';
import { fromQuery, safeFrom } from './topup-from';
import { useTopupIntent } from './use-intent-status';
import { useCancelIntent, useOpenPayPage } from './use-open-pay-page';

const LOW_MS = 5 * 60 * 1000;

function Mark({ icon, tone }: { icon: typeof Check; tone: 'info' | 'muted' }) {
  return (
    <span
      aria-hidden="true"
      className={`grid size-20 place-items-center rounded-full ${
        tone === 'info' ? 'bg-info-soft text-info-text' : 'bg-muted text-foreground-secondary'
      }`}
    >
      <Icon icon={icon} size={34} />
    </span>
  );
}

function Credited({ intent, from }: { intent: TopupIntent; from: string | null }) {
  const t = useTranslations('tg.topup');
  const formatMoney = useFormatMoney();
  const wallet = useWallet();
  const router = useRouter();
  useEffect(() => {
    haptics.success();
  }, []);
  return (
    <section
      role="status"
      className="relative flex flex-1 flex-col items-center justify-center gap-3 py-12 text-center"
    >
      <SuccessBurst orderId={`topup:${intent.intentId}`} />
      <span
        aria-hidden="true"
        className="grid size-[88px] animate-[gg-pop_var(--dur-slower)_var(--ease-spring)_both] place-items-center rounded-full bg-success text-card motion-reduce:animate-none"
      >
        <Icon icon={Check} size={42} />
      </span>
      <h1 className="m-0 mt-2 text-2xl leading-[30px] font-extrabold">{t('credited.title')}</h1>
      <Money tiyin={intent.creditedTiyin ?? intent.payAmountTiyin} tone="credit" size="lg" />
      {wallet.data === undefined ? null : (
        <span className="text-sm font-bold text-foreground-secondary tabular-nums">
          {t('credited.balance', { balance: formatMoney(wallet.data.balanceTiyin) })}
        </span>
      )}
      <div className="mt-4 flex w-full max-w-[360px] flex-col gap-2">
        <Button size="lg" glow className="w-full" onClick={() => router.replace(from ?? '/tg')}>
          {from === null ? t('credited.home') : t('credited.buy')}
        </Button>
        {from === null ? null : (
          <Button
            variant="ghost"
            size="lg"
            className="w-full"
            onClick={() => router.replace('/tg')}
          >
            {t('credited.home')}
          </Button>
        )}
      </div>
    </section>
  );
}

function Ended({ kind, from }: { kind: 'expired' | 'cancelled'; from: string | null }) {
  const t = useTranslations('tg.topup');
  return (
    <section
      role="status"
      className="flex flex-1 flex-col items-center justify-center gap-3 py-12 text-center"
    >
      <Mark
        icon={kind === 'expired' ? TimerOff : CircleX}
        tone={kind === 'expired' ? 'info' : 'muted'}
      />
      <h1 className="m-0 mt-2 max-w-[360px] text-2xl leading-[30px] font-extrabold text-balance">
        {t(`${kind}.title`)}
      </h1>
      <p
        className={`m-0 max-w-[400px] rounded-[14px] px-3.5 py-3 text-sm leading-5 font-semibold text-pretty ${
          kind === 'expired' ? 'bg-info-soft text-info-text' : 'bg-muted text-foreground-secondary'
        }`}
      >
        {t(`${kind}.body`)}
      </p>
      <div className="mt-4 flex w-full max-w-[360px] flex-col gap-1.5">
        <Button asChild size="lg" glow className="w-full">
          <Link href={`/tg/topup${fromQuery(from)}`} replace>
            {t(`${kind}.newPayment`)}
          </Link>
        </Button>
        <SupportLinkButton variant="ghost" className="w-full" fallbackToBot>
          {t(`${kind}.support`)}
        </SupportLinkButton>
      </div>
    </section>
  );
}

/**
 * The waiting screen (`/tg/topup/<intentId>`, TopupMini.dc.html `waiting`): the payment page is open
 * in the browser, here is the amount to pay, the time left and the live status. Coming back from
 * the browser asks again at once. Credited, expired and cancelled each have their own end.
 */
export function TopupWaiting({ intentId }: { intentId: string }) {
  const t = useTranslations('tg.topup');
  const common = useTranslations('common');
  const from = safeFrom(useSearchParams().get('from'));
  const query = useTopupIntent(intentId);
  const intent = query.data;
  const msLeft = useCountdown(
    intent === undefined ? null : Date.parse(intent.expiresAt),
    query.dataUpdatedAt,
  );
  const page = useOpenPayPage();
  const cancel = useCancelIntent();
  const [linkFailed, setLinkFailed] = useState(false);
  const [asking, setAsking] = useState(false);
  const [cancelFailed, setCancelFailed] = useState(false);

  let body;
  if (query.isPending) {
    body = (
      <div
        role="status"
        aria-busy="true"
        aria-label={common('loading')}
        className="flex flex-col gap-4"
      >
        <Skeleton className="h-8 w-4/5 rounded-lg" />
        <Skeleton className="h-[132px] rounded-[20px]" />
        <Skeleton className="h-12 rounded-2xl" />
      </div>
    );
  } else if (intent === undefined) {
    body =
      isApiError(query.error) && query.error.status === 404 ? (
        <EmptyState
          icon={<Icon icon={WalletCards} size={24} />}
          title={t('waiting.notFound.title')}
          description={t('waiting.notFound.body')}
          action={
            <Button asChild variant="secondary">
              <Link href="/tg">{t('credited.home')}</Link>
            </Button>
          }
        />
      ) : (
        <ErrorState
          title={common('error.network')}
          retryLabel={common('retry')}
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      );
  } else if (intent.status === 'PAID') {
    body = <Credited intent={intent} from={from} />;
  } else if (intent.status === 'EXPIRED' || (intent.status === 'PENDING' && msLeft <= 0)) {
    body = <Ended kind="expired" from={from} />;
  } else if (intent.status === 'CANCELLED') {
    body = <Ended kind="cancelled" from={from} />;
  } else {
    const low = msLeft < LOW_MS;
    body = (
      <>
        <div className="flex flex-col gap-2">
          <h1 className="m-0 text-2xl leading-[30px] font-extrabold tracking-[-.02em] text-balance">
            {t('waiting.title')}
          </h1>
          <p className="m-0 text-[15px] leading-[22px] font-medium text-foreground-secondary text-pretty">
            {t('waiting.line')}
          </p>
        </div>
        <section className="flex items-center gap-4 rounded-[24px] border border-border bg-card p-5 shadow-sm">
          <CountdownRing msLeft={msLeft} low={low} />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[13px] leading-[18px] font-bold text-foreground-muted">
              {t('waiting.toPay')}
            </span>
            <Money tiyin={intent.payAmountTiyin} size="lg" />
            <span
              data-testid="topup-left"
              className={`text-sm leading-5 font-extrabold tabular-nums ${low ? 'text-warning-text' : 'text-foreground-secondary'}`}
            >
              {t('waiting.left', { time: mmss(msLeft) })}
            </span>
          </div>
        </section>
        <TopupNotes />
        <span
          role="status"
          aria-live="polite"
          className="flex items-center gap-2.5 text-sm font-bold text-foreground-secondary"
        >
          <WaitingDot />
          {t('waiting.status')}
        </span>
        {linkFailed ? (
          <p role="alert" className="m-0 text-sm font-bold text-danger-text">
            {t('waiting.linkError')}
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          {page.held ? (
            // The client refused the link after the tap; this press opens it with no `await` between.
            <Button
              size="lg"
              glow
              onClick={() => setLinkFailed(!page.openHeld())}
              className="w-full"
            >
              <Icon icon={ExternalLink} size={17} />
              {t('waiting.openPage')}
            </Button>
          ) : (
            <Button
              size="lg"
              glow
              loading={page.opening}
              onClick={() => {
                setLinkFailed(false);
                void page.open(intentId).then((opened) => setLinkFailed(opened === false));
              }}
              className="w-full"
            >
              <Icon icon={ExternalLink} size={17} />
              {t('waiting.reopen')}
            </Button>
          )}
          <Button variant="outline" size="lg" onClick={() => setAsking(true)} className="w-full">
            {t('waiting.cancel')}
          </Button>
        </div>
        <CancelDialog
          open={asking}
          cancelling={cancel.cancelling}
          failed={cancelFailed}
          onClose={() => setAsking(false)}
          onConfirm={() => {
            setCancelFailed(false);
            void cancel.cancel(intentId).then((done) => {
              if (done) setAsking(false);
              else setCancelFailed(true);
            });
          }}
        />
      </>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[640px] flex-col gap-4 bg-background px-4 pt-[max(12px,var(--tg-safe-top,0px))] pb-[max(32px,var(--tg-safe-bottom,0px))] text-foreground">
      {body}
    </main>
  );
}
