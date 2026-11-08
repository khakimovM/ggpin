'use client';

import type { CatalogProductDetail } from '@repo/shared';
import { balanceAfterPurchase } from '@repo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Crown, Package, Star, type LucideIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { localizedPath } from '../../i18n/paths';
import { useFormatMoney } from '../../lib/format/money';
import { getAttempt } from '../../lib/order-attempts';
import { qk } from '../../lib/query-keys';
import { useTelegram } from '../../telegram/telegram-context';
import { useBackInterceptor } from '../../telegram/use-back-button';
import { useClosingGuard } from '../../telegram/use-closing-guard';
import { useMainButton } from '../../telegram/use-main-button';
import { useCountdown } from '../auth/use-countdown';
import { useMe } from '../auth/use-me';
import type { QuoteControls } from '../product/use-quote';
import { retryDelaySec } from '../product/retry-delay';
import { useWallet } from '../wallet/use-wallet';
import { ConfirmSheet } from './ConfirmSheet';
import { FrozenSheet } from './FrozenSheet';
import { InsufficientSheet } from './InsufficientSheet';
import { deriveConfirmState } from './confirm-state';
import { mainButtonAction, type MainButtonRun } from './main-button-action';
import type { PayOutcome } from './pay-outcome';
import { useCreateOrder, useUncertainOrder } from './use-create-order';

export interface CheckoutFlowProps {
  variant: 'tg' | 'web';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: CatalogProductDetail;
  /** "Telegram Stars · 500 ⭐". */
  item: string;
  recipient: { username: string; displayName: string };
  quote: QuoteControls;
}

const GLYPH: Record<string, LucideIcon> = { 'telegram-stars': Star, 'telegram-premium': Crown };

/**
 * From "Sotib olish" to the order page. It shows the confirmation of the LIVE quote, pays it once
 * (one `Idempotency-Key` per quote, written down BEFORE the request, see use-create-order.ts) and
 * turns every answer into a screen: the order, "Mablag‘ yetarli emas" with the server's numbers, a
 * price to renew, the frozen account, or the error. When the answer is LOST the screen turns to
 * "result unknown" (also after a reload, and in another tab): only "check again" is offered, with
 * the same quote and key, whatever the local clock says; the price is renewed only once the server
 * has said there is no order. Nothing here computes a price or a balance; "left" is the
 * display-only `balanceAfterPurchase`. In the Mini App the action is Telegram's MainButton.
 */
export function CheckoutFlow({
  variant,
  open,
  onOpenChange,
  product,
  item,
  recipient,
  quote,
}: CheckoutFlowProps) {
  const t = useTranslations('store.checkout');
  const all = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const queryClient = useQueryClient();
  const formatMoney = useFormatMoney();
  const { webApp } = useTelegram();
  const wallet = useWallet({ enabled: open });
  const me = useMe();
  const userId = me.data?.id ?? null;
  const { pay } = useCreateOrder(userId, variant);
  const attempt = useUncertainOrder(userId);
  const [paying, setPaying] = useState(false);
  // True while the FIRST send of a purchase runs (the record exists already, but it is "paying",
  // not yet "unknown"); false for a check of an earlier one.
  const [firstSend, setFirstSend] = useState(false);
  const [outcome, setOutcome] = useState<PayOutcome | null>(null);
  const [busyRecord, setBusyRecord] = useState(false);
  const [staleId, setStaleId] = useState<string | null>(null);
  // A 429 on the check: the button waits that long.
  const [wait, setWait] = useState<{ until: number; from: number } | null>(null);
  const waitMs = useCountdown(wait?.until ?? null, wait?.from ?? 0);
  // Set synchronously when a payment starts, so a second tap in the same tick (before React has
  // re-rendered with `paying`) is ignored. It stays set for a quote that became an order.
  const busyQuote = useRef<string | null>(null);
  // How many answers in a row said "no such quote": a second one is an error, not another price.
  const expiredRuns = useRef(0);
  useClosingGuard(webApp, paying);

  const { view } = quote;
  const live = view.status === 'ready' && !view.expired ? view.quote : null;
  const lapsed = view.status === 'ready' && view.expired;

  const close = (next: boolean) => {
    if (!next) {
      setOutcome(null);
      setStaleId(null);
      expiredRuns.current = 0;
    }
    onOpenChange(next);
  };
  // In the Mini App the native BackButton closes the sheet before it leaves the page. While the
  // payment is on its way it does nothing: the answer is still coming (the sheet cannot be closed
  // either).
  useBackInterceptor(variant === 'tg' && open, () => {
    if (!paying) close(false);
  });

  // The price could not be renewed because the recipient's confirmation died: the product page
  // takes the visitor back to confirm the recipient again, so the sheet steps aside.
  const dead = open && view.status === 'recipientInvalid';
  useEffect(() => {
    if (dead) onOpenChange(false);
  }, [dead, onOpenChange]);

  const orderHref = (id: string) =>
    variant === 'tg' ? `/tg/orders/${id}` : localizedPath(locale, `/store/orders/${id}`);

  const submit = async (quoteId: string) => {
    if (busyQuote.current === quoteId) return;
    busyQuote.current = quoteId;
    // The quote on screen when the button was pressed; the purchase in doubt may be another one.
    const shown = view.status === 'ready' ? view.quote.quoteId : null;
    setFirstSend(attempt === null);
    setOutcome(null);
    setPaying(true);
    let result: PayOutcome;
    try {
      result = await pay(quoteId, item);
    } catch {
      // The payment machinery itself failed: nothing is known about the order. The write-ahead record
      // (if it was written) turns the sheet to "result unknown"; either way the spinner and the
      // closing prompt go away.
      result = { kind: 'uncertain', quoteId };
    } finally {
      setPaying(false);
    }
    if (result.kind === 'ok') {
      expiredRuns.current = 0;
      close(false);
      // The quote that became an order is spent: going Back must not show its price as live.
      if (quoteId === shown) quote.discard();
      router.push(orderHref(result.orderId));
      return;
    }
    busyQuote.current = null;
    // Another window is paying: nothing was sent here; its record turns this sheet to "result
    // unknown" (if it is not written yet the message alone is shown).
    if (result.kind === 'busy') {
      // Remember whether the other window's record is there: when it goes, so does this message.
      setBusyRecord(userId !== null && getAttempt(userId) !== null);
      setOutcome(result);
      return;
    }
    if (result.kind === 'expired') {
      // The doubt about an OLD purchase ended with "no order": nothing else changes, the price on
      // screen is another quote and is still good.
      if (quoteId !== shown) return;
      // The server says there is no such quote (and so no order): a new one is fetched, which the
      // visitor then confirms. Twice in a row means something else is wrong: an error, no loop.
      expiredRuns.current += 1;
      setStaleId(quoteId);
      if (expiredRuns.current >= 2) setOutcome({ kind: 'failed', code: 'INTERNAL_ERROR' });
      else quote.refresh();
      return;
    }
    expiredRuns.current = 0;
    if (result.kind === 'insufficient') {
      void queryClient.invalidateQueries({ queryKey: qk.wallet.all });
    }
    if (result.kind === 'failed' && result.code === 'RATE_LIMITED') {
      const from = Date.now();
      setWait({ from, until: from + retryDelaySec(result.retryAfterSec) * 1000 });
    }
    // An uncertain answer needs no state here: the attempt store carries it and turns the sheet.
    if (result.kind !== 'uncertain') setOutcome(result);
  };
  const onPay = () =>
    live === null || attempt !== null || userId === null ? Promise.resolve() : submit(live.quoteId);
  // Asks again with the SAME quote and key; the local clock has no say.
  const onCheck = () =>
    attempt === null || waitMs > 0 ? Promise.resolve() : submit(attempt.quoteId);
  const renew = () => {
    // A price that ran out on the clock is renewed like one the server refused: the visitor sees the
    // new price before paying it.
    if (view.status === 'ready') setStaleId(view.quote.quoteId);
    quote.refresh();
  };
  const proceed = () => {
    setStaleId(null);
    setOutcome(null);
  };

  // "A payment is on its way in another window" is gone once that window's record is: it settled (or
  // was refused) there. A state reset during render, guarded by the condition, is React's own pattern.
  if (outcome?.kind === 'busy' && busyRecord && attempt === null) {
    setOutcome(null);
    setBusyRecord(false);
  }

  const { state, messageKey } = deriveConfirmState({
    uncertain: attempt !== null && !(paying && firstSend),
    paying,
    noUser: userId === null,
    outcome,
    staleId,
    live,
    lapsed,
    viewStatus: view.status,
  });
  const message = messageKey === undefined ? undefined : all(messageKey);

  const total = live?.totalTiyin ?? null;
  const balance = wallet.data?.balanceTiyin ?? null;
  const left = total !== null && balance !== null ? balanceAfterPurchase(balance, total) : null;
  const totalLabel = total === null ? '' : formatMoney(total);

  const sheetOpen = open && outcome?.kind !== 'insufficient' && outcome?.kind !== 'frozen';
  const native = variant === 'tg';
  // Telegram's own button, used while the sheet is open (the page's buy button steps aside).
  const { run, ...look } = mainButtonAction(
    state,
    {
      pay: t('confirm.pay', { total: totalLabel }),
      check: t('uncertain.retry'),
      renew: t('expired.renew'),
      proceed: t('expired.continue'),
      retry: t('failed.retry'),
    },
    { paying, checkBlocked: waitMs > 0 },
  );
  const handlers: Record<MainButtonRun, () => Promise<void>> = {
    pay: onPay,
    check: onCheck,
    renew: () => Promise.resolve(renew()),
    proceed: () => Promise.resolve(proceed()),
    none: () => Promise.resolve(),
  };
  useMainButton(native && sheetOpen ? webApp : null, { ...look, onClick: handlers[run] });

  return (
    <>
      <ConfirmSheet
        open={sheetOpen}
        onOpenChange={close}
        state={state}
        nativeAction={native && state !== 'failed'}
        glyph={GLYPH[product.slug] ?? Package}
        item={item}
        recipient={`@${recipient.username} · ${recipient.displayName}`}
        priceTiyin={live?.priceTiyin ?? null}
        totalTiyin={total}
        balanceTiyin={balance}
        leftTiyin={left}
        msLeft={view.status === 'ready' ? view.msLeft : null}
        message={message}
        attemptLabel={attempt?.label}
        checkWaitSec={Math.ceil(waitMs / 1000)}
        checking={state === 'uncertain' && paying}
        onPay={() => void onPay()}
        onRenew={renew}
        onContinue={proceed}
        onRetry={() => {
          // An uncertain payment is asked about again on the SAME quote (same Idempotency-Key). A
          // payment that failed otherwise just returns to the confirmation; only a price that could
          // not be had is asked for again.
          if (userId === null) void me.refetch();
          else if (state === 'uncertain') void onCheck();
          else if (outcome?.kind === 'failed' || outcome?.kind === 'busy') setOutcome(null);
          else quote.refresh();
        }}
      />
      {outcome?.kind === 'insufficient' ? (
        <InsufficientSheet open={open} onOpenChange={close} details={outcome} />
      ) : null}
      {outcome?.kind === 'frozen' ? (
        <FrozenSheet open={open} onOpenChange={close} uncertain={attempt !== null} />
      ) : null}
    </>
  );
}
