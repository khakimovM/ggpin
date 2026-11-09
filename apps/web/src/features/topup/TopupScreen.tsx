'use client';

import { somToTiyin } from '@repo/shared';
import { Button, ErrorState, Icon, Skeleton } from '@repo/ui';
import { ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useFormatMoney } from '../../lib/format/money';
import { haptics } from '../../telegram/haptics';
import { openLink } from '../../telegram/open-link';
import { useTelegram } from '../../telegram/telegram-context';
import { useMainButton } from '../../telegram/use-main-button';
import { useCountdown } from '../auth/use-countdown';
import { CancelDialog } from './CancelDialog';
import { PendingSheet } from './PendingSheet';
import { TopupAmountForm, type BankChoice } from './TopupAmountForm';
import { TopupUnavailable } from './TopupUnavailable';
import { amountProblem } from './topup-limits';
import { fromQuery, safeFrom } from './topup-from';
import type { CreateOutcome } from './topup-outcome';
import { useCreateIntent } from './use-create-intent';
import { usePendingIntent } from './use-intent-status';
import { useCancelIntent, useOpenPayPage } from './use-open-pay-page';
import { useTopupMethods } from './use-topup-methods';

/**
 * The Mini App's top-up (`/tg/topup`, TopupMini.dc.html `amount`): amount, quick amounts, card type,
 * then "Davom etish". The card and the exact amount are NEVER shown here (Telegram's policy): the
 * request is created, its payment page opens in the browser (`openLink`, our own `/pay/` only) and
 * the waiting screen takes over. If the client refuses the link (it came after an `await`), the
 * link is held for one more press that opens it synchronously. A request that is already waiting is
 * offered first.
 */
export function TopupScreen() {
  const t = useTranslations('store.topup');
  const tg = useTranslations('tg.topup');
  const common = useTranslations('common');
  const router = useRouter();
  const formatMoney = useFormatMoney();
  const from = safeFrom(useSearchParams().get('from'));
  const { webApp } = useTelegram();
  const { query: methods, limits } = useTopupMethods();
  const pending = usePendingIntent();
  const { create, creating, waitMs } = useCreateIntent();
  const page = useOpenPayPage();
  const cancelIntent = useCancelIntent();

  const [amount, setAmount] = useState('');
  const [bank, setBank] = useState<BankChoice>('auto');
  const [outcome, setOutcome] = useState<CreateOutcome | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [sheetFailed, setSheetFailed] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  // The request that was just created but whose page the client would not open.
  const [stuckId, setStuckId] = useState<string | null>(null);

  const intent = pending.data ?? null;
  const msLeft = useCountdown(
    intent === null ? null : Date.parse(intent.expiresAt),
    pending.dataUpdatedAt,
  );
  const sheetOpen = intent !== null && msLeft > 0 && !dismissed && stuckId === null;
  const problem = limits ? amountProblem(amount, limits) : null;
  const ready = amount !== '' && problem === null && !creating && waitMs <= 0;
  const waitSec = Math.ceil(waitMs / 1000);

  const editAmount = (digits: string) => {
    setAmount(digits);
    setOutcome(null);
  };
  const waitingUrl = (id: string) => `/tg/topup/${id}${fromQuery(from)}`;

  const onContinue = async () => {
    if (!ready) return;
    const result = await create(amount, bank === 'auto' ? undefined : bank);
    if (result === null) return;
    if (result.kind === 'created') {
      haptics.success();
      if (openLink(result.redirectUrl)) {
        router.replace(waitingUrl(result.intentId));
      } else if (page.hold(result.redirectUrl)) {
        haptics.error();
        setStuckId(result.intentId);
      } else {
        // A link of another origin: nothing is opened; the request waits and is offered as usual.
        haptics.error();
        setOutcome({ kind: 'failed', code: 'INTERNAL_ERROR' });
        setDismissed(false);
        void pending.refetch();
      }
      return;
    }
    haptics.error();
    if (result.kind === 'pending' || result.kind === 'conflict') {
      setDismissed(false);
      const fresh = (await pending.refetch()).data ?? null;
      // The sheet opens only for a request that is still waiting; otherwise say what happened.
      if (fresh === null || Date.parse(fresh.expiresAt) <= Date.now()) {
        setOutcome({ kind: 'conflict', intentId: result.intentId });
      }
      return;
    }
    setOutcome(result);
  };

  const openStuck = () => {
    if (stuckId !== null && page.openHeld()) router.replace(waitingUrl(stuckId));
  };
  const openPending = async () => {
    if (intent === null) return;
    setSheetFailed(false);
    if (page.held) {
      // The client refused the fresh link before: this press opens it with no `await` in between.
      if (page.openHeld()) router.push(waitingUrl(intent.intentId));
      else setSheetFailed(true);
      return;
    }
    const opened = await page.open(intent.intentId);
    if (opened === true) router.push(waitingUrl(intent.intentId));
    else if (opened === false) setSheetFailed(true);
  };
  const cancelPending = async () => {
    if (intent === null) return;
    setSheetFailed(false);
    if (await cancelIntent.cancel(intent.intentId)) {
      setDismissed(false);
      void pending.refetch();
    } else setSheetFailed(true);
  };

  const native = webApp !== null;
  const stuck = stuckId !== null && page.held;
  const showButton =
    stuck ||
    (limits !== undefined && limits !== null && outcome?.kind !== 'unavailable' && !sheetOpen);
  const mainText = stuck
    ? tg('waiting.openPage')
    : creating
      ? t('creating')
      : amount === '' || problem !== null
        ? t('continue')
        : t('continueAmount', { amount: formatMoney(somToTiyin(amount).toString()) });
  useMainButton(native && showButton ? webApp : null, {
    text: mainText,
    enabled: stuck || ready,
    loading: creating,
    // Called straight from the tap: `openStuck` runs before the first `await`, not after it.
    onClick: stuck
      ? () => {
          openStuck();
          return Promise.resolve();
        }
      : onContinue,
  });

  let body;
  if (stuck) {
    body = (
      <section role="alert" className="flex flex-col gap-4">
        <p className="m-0 text-[15px] leading-[22px] font-bold text-danger-text">
          {tg('waiting.linkError')}
        </p>
        {native ? null : (
          <Button size="lg" glow onClick={openStuck} className="w-full">
            <Icon icon={ExternalLink} size={17} />
            {tg('waiting.openPage')}
          </Button>
        )}
      </section>
    );
  } else if (methods.isPending) {
    body = (
      <div
        role="status"
        aria-busy="true"
        aria-label={common('loading')}
        className="flex flex-col gap-4"
      >
        <Skeleton className="h-[88px] rounded-md" />
        <Skeleton className="h-11 rounded-full" />
        <Skeleton className="h-[168px] rounded-[20px]" />
      </div>
    );
  } else if (methods.isError) {
    body = (
      <ErrorState
        title={common('error.network')}
        retryLabel={common('retry')}
        retrying={methods.isFetching}
        onRetry={() => void methods.refetch()}
      />
    );
  } else if (limits === null || limits === undefined || outcome?.kind === 'unavailable') {
    body = (
      <TopupUnavailable
        retrying={methods.isFetching}
        onRetry={() => {
          setOutcome(null);
          void methods.refetch();
        }}
      />
    );
  } else {
    body = (
      <>
        <TopupAmountForm
          limits={limits}
          amount={amount}
          onAmount={editAmount}
          bank={bank}
          onBank={setBank}
          outcome={outcome}
          disabled={creating}
          waitSec={waitSec}
        />
        {native ? null : (
          <Button
            size="lg"
            glow
            loading={creating}
            disabled={!ready}
            onClick={() => void onContinue()}
            className="w-full"
          >
            {mainText}
          </Button>
        )}
      </>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[640px] flex-col gap-4 bg-background px-4 pt-[max(12px,var(--tg-safe-top,0px))] pb-[max(96px,var(--tg-safe-bottom,0px))] text-foreground">
      <h1 className="m-0 text-2xl leading-[30px] font-extrabold tracking-[-.02em]">{t('title')}</h1>
      {body}
      {intent === null ? null : (
        <PendingSheet
          open={sheetOpen && !confirmCancel}
          intent={intent}
          msLeft={msLeft}
          busy={page.opening ? 'open' : cancelIntent.cancelling ? 'cancel' : null}
          failed={sheetFailed}
          onOpenPage={() => void openPending()}
          onCancelAndNew={() => setConfirmCancel(true)}
          onClose={() => setDismissed(true)}
        />
      )}
      <CancelDialog
        open={confirmCancel}
        cancelling={cancelIntent.cancelling}
        failed={sheetFailed}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => {
          void cancelPending().then(() => setConfirmCancel(false));
        }}
      />
    </main>
  );
}
