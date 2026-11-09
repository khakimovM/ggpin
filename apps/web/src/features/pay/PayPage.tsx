'use client';

import { Button, ErrorState, Icon, Skeleton } from '@repo/ui';
import { Send } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect } from 'react';
import { env } from '../../env';
import { useFormatMoney } from '../../lib/format/money';
import { useCountdown } from '../auth/use-countdown';
import { SupportLinkButton } from '../support/SupportLinkButton';
import { PayBar } from './PayBar';
import { PayBody } from './PayBody';
import { PayFinal, type PayFinalKind } from './PayFinal';
import { PayHeader } from './PayHeader';
import { isStale, payScreenOf } from './pay-state';
import {
  clearPayToken,
  markPayDone,
  rememberPayExpiry,
  usePayDone,
  usePayToken,
  type PayDoneStatus,
} from './pay-token';
import { usePayView } from './use-pay-view';

const BOT_URL = `https://t.me/${env.NEXT_PUBLIC_BOT_USERNAME}`;

function PaySkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="flex flex-col gap-4">
      <Skeleton className="h-6 w-3/5 rounded-lg" />
      <Skeleton className="h-[210px] rounded-[24px]" />
      <Skeleton className="h-[200px] rounded-[24px]" />
      <Skeleton className="h-[76px] rounded-[20px]" />
      <Skeleton className="h-[180px] rounded-[20px]" />
    </div>
  );
}

/**
 * `/pay/<intentId>` (PayPage.dc.html mode=page): the card and the EXACT amount of one top-up
 * request, opened from the Mini App in the external browser, without a session. The capability
 * token comes from the URL fragment and goes to the API in a header; nothing of the wallet, the
 * profile or the user shows here. Every state of the design: loading, waiting (with a "not
 * updated" bar after a failed poll), credited, expired, cancelled, invalid link.
 */
export function PayPage({ intentId }: { intentId: string }) {
  const t = useTranslations('pay');
  const locale = useLocale();
  const formatMoney = useFormatMoney();
  const token = usePayToken(intentId);
  const { query, answeredToken } = usePayView(intentId, token);
  const done = usePayDone(intentId);
  const data = query.data;
  const msLeft = useCountdown(
    data === undefined ? null : Date.parse(data.expiresAt),
    query.dataUpdatedAt,
  );
  const screen = payScreenOf({ token, data, error: query.error, msLeft, done });
  const stale = isStale(data, query.error);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  // The token is kept for this tab only while it can still be used: with the answer's expiry beside
  // it, and gone the moment the request has ended or the server stopped knowing it.
  const expiresAt = data?.expiresAt;
  const ended = screen === 'credited' || screen === 'cancelled' || screen === 'expired';
  const endStatus: PayDoneStatus =
    data?.status === 'PAID' || data?.status === 'CANCELLED' ? data.status : 'EXPIRED';
  // "Unknown token" counts only when the server said it for the token held NOW (see usePayView).
  const refused = screen === 'invalid' && typeof token === 'string' && answeredToken === token;
  useEffect(() => {
    if (expiresAt !== undefined) rememberPayExpiry(intentId, expiresAt);
  }, [intentId, expiresAt]);
  useEffect(() => {
    // The marker first (no secret in it), then the token goes: a reload can say "finished".
    if (ended) markPayDone(intentId, endStatus);
    if (ended || refused) clearPayToken(intentId);
  }, [intentId, ended, endStatus, refused]);

  const botButton = (label: string) => (
    <Button asChild size="lg" className="w-full">
      <a href={BOT_URL} rel="noopener noreferrer">
        <Icon icon={Send} size={17} />
        {label}
      </a>
    </Button>
  );
  const back = botButton(t('cta.back'));
  const final = (kind: PayFinalKind) =>
    kind === 'done' ? (
      // A finished request seen again after the token was erased: nothing of it is shown.
      <PayFinal kind="done" actions={botButton(t('cta.bot'))} />
    ) : (
      <PayFinal
        kind={kind}
        burstId={`pay:${intentId}`}
        creditedText={data === undefined ? undefined : `+${formatMoney(data.payAmountTiyin)}`}
        ownerHint={data?.ownerHint ?? null}
        actions={
          <>
            {back}
            {kind === 'credited' ? null : (
              <SupportLinkButton variant="ghost" className="w-full" fallbackToBot>
                {t('cta.support')}
              </SupportLinkButton>
            )}
          </>
        }
      />
    );

  let body;
  if (screen === 'loading') body = <PaySkeleton label={t('loading')} />;
  else if (screen === 'failed') {
    body = (
      <ErrorState
        title={t('netError')}
        retryLabel={t('retry')}
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    );
  } else if (screen === 'pay' && data !== undefined && data.card !== null) {
    body = (
      <>
        <h1 id="pay-title" className="m-0 text-[22px] leading-7 font-extrabold tracking-[-.01em]">
          {t('title')}
        </h1>
        <PayBody
          wide
          payAmountTiyin={data.payAmountTiyin}
          card={data.card}
          msLeft={msLeft}
          stale={stale}
          ownerHint={data.ownerHint}
        />
      </>
    );
  } else {
    body = final(screen === 'pay' ? 'invalid' : screen);
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <PayHeader />
      <main className="mx-auto flex w-full max-w-[560px] flex-1 flex-col gap-4 px-4 pt-5 pb-6 lg:max-w-[1040px]">
        {body}
      </main>
      {screen === 'pay' ? (
        <PayBar
          sticky
          netError={stale}
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
          msLeft={msLeft}
        />
      ) : null}
    </div>
  );
}
