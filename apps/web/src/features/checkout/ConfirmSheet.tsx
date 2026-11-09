'use client';

import { Button, Icon, Sheet, Spinner } from '@repo/ui';
import { RefreshCcw, Timer, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { MONEY_PLACEHOLDER, Money, useFormatMoney } from '../../lib/format/money';
import { useDateFormat } from '../../lib/format/use-date-format';
import { UncertainNote } from './UncertainNote';

/**
 * - `ready`: the price is live, "To‘lash" is on.
 * - `paying`: the request is on its way; the button shows progress and presses are ignored.
 * - `expired`: the price ran out (locally or by a 410): it must be renewed before paying.
 * - `refreshing`: a new price is being fetched.
 * - `renewed`: a new price arrived; the visitor sees it and chooses to go on.
 * - `uncertain`: the answer to a payment never came; only "check again" is offered, no price at all.
 * - `failed`: any other answer; `message` says what.
 */
export type ConfirmState =
  'ready' | 'paying' | 'expired' | 'refreshing' | 'renewed' | 'uncertain' | 'failed';

export interface ConfirmSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: ConfirmState;
  /** In the Mini App the action is Telegram's MainButton; the sheet then draws no button. */
  nativeAction: boolean;
  glyph: LucideIcon;
  /** "Telegram Stars · 500 ⭐". */
  item: string;
  /** "@dilnoza_k · Dilnoza K.". */
  recipient: string;
  /** Server strings; null while there is no live price. */
  priceTiyin: string | null;
  totalTiyin: string | null;
  balanceTiyin: string | null;
  /** The wallet after the purchase, for display; null when it cannot be shown. */
  leftTiyin: string | null;
  /** Milliseconds the price still lives. */
  msLeft: number | null;
  message?: string;
  /** The check of an uncertain payment is on its way. */
  checking?: boolean;
  /** What the purchase in doubt was (product and variant, never an amount). */
  attemptLabel?: string;
  /** Seconds the check must still wait after a 429; 0 when it may go now. */
  checkWaitSec?: number;
  onPay: () => void;
  onRenew: () => void;
  onContinue: () => void;
  onRetry: () => void;
  footerExtra?: ReactNode;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-foreground-muted">{label}</span>
      <span>{children}</span>
    </div>
  );
}

/**
 * "Buyurtmani tasdiqlang" (Checkout.dc.html `confirm`, `confirmPaying`, `confirmExpired`): what is
 * bought, for whom, at which price, and the wallet before and after. Every figure is the server's
 * string; "left" is the one display-only subtraction (`balanceAfterPurchase`) and the server
 * checks the real balance when the order is placed.
 */
export function ConfirmSheet(props: ConfirmSheetProps) {
  const { open, onOpenChange, state, nativeAction, item, recipient, message } = props;
  const t = useTranslations('store.checkout');
  const formatMoney = useFormatMoney();
  const { countdown } = useDateFormat();
  const total = props.totalTiyin;
  const busy = state === 'paying' || state === 'refreshing';
  const waitSec = props.checkWaitSec ?? 0;
  const live = state === 'ready' || state === 'paying';

  const balanceLine =
    props.balanceTiyin === null
      ? MONEY_PLACEHOLDER
      : props.leftTiyin === null
        ? formatMoney(props.balanceTiyin)
        : t('confirm.balanceAfter', {
            balance: formatMoney(props.balanceTiyin),
            left: formatMoney(props.leftTiyin),
          });

  // The one way to close: not while the payment (or its check) is on its way, the answer is still
  // coming. The sheet's own close, Escape, the overlay and "Bekor qilish" all go through it.
  const requestOpen = (next: boolean) => {
    if (!next && (state === 'paying' || props.checking)) return;
    onOpenChange(next);
  };

  let action: ReactNode = null;
  if (!nativeAction) {
    if (state === 'ready' || state === 'paying') {
      // Store.dc.html modal: "Bekor qilish" beside the pay button from 768 px; on a phone the
      // sheet has its close button and the pay button alone.
      action = (
        <div className="grid gap-2.5 md:grid-cols-[auto_minmax(0,1fr)]">
          <Button
            variant="outline"
            size="lg"
            disabled={state === 'paying' || props.checking}
            onClick={() => requestOpen(false)}
            className="hidden md:inline-flex"
          >
            {t('confirm.cancel')}
          </Button>
          <Button
            size="lg"
            glow
            loading={state === 'paying'}
            onClick={props.onPay}
            className="w-full"
          >
            {state === 'paying'
              ? t('confirm.paying')
              : t('confirm.pay', {
                  total: total === null ? MONEY_PLACEHOLDER : formatMoney(total),
                })}
          </Button>
        </div>
      );
    } else if (state === 'expired' || state === 'refreshing') {
      action = (
        <Button
          size="lg"
          glow
          loading={state === 'refreshing'}
          onClick={props.onRenew}
          className="w-full"
        >
          <Icon icon={RefreshCcw} size={17} />
          {state === 'refreshing' ? t('expired.renewing') : t('expired.renew')}
        </Button>
      );
    } else if (state === 'uncertain') {
      action = (
        <Button
          size="lg"
          glow
          loading={props.checking}
          disabled={waitSec > 0}
          onClick={props.onRetry}
          className="w-full"
        >
          {props.checking
            ? t('uncertain.checking')
            : waitSec > 0
              ? t('uncertain.wait', { seconds: waitSec })
              : t('uncertain.retry')}
        </Button>
      );
    } else if (state === 'renewed') {
      action = (
        <Button size="lg" glow onClick={props.onContinue} className="w-full">
          <Icon icon={RefreshCcw} size={17} />
          {t('expired.continue')}
        </Button>
      );
    } else {
      action = (
        <Button size="lg" onClick={props.onRetry} className="w-full">
          {t('failed.retry')}
        </Button>
      );
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={requestOpen}
      title={t('confirm.title')}
      closeLabel={t('confirm.close')}
      size="lg"
      footer={action ?? props.footerExtra}
    >
      {state === 'uncertain' ? (
        <UncertainNote label={props.attemptLabel} message={message} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 text-sm leading-5 font-semibold tabular-nums">
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="grid size-11 shrink-0 place-items-center rounded-[14px] bg-star-soft text-star"
              >
                <Icon icon={props.glyph} size={20} />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[15px] leading-5 font-extrabold break-words">{item}</span>
                <span className="text-foreground-secondary break-words">{recipient}</span>
              </span>
            </div>
            <div className="h-px bg-border" />
            <Row label={t('confirm.price')}>
              {props.priceTiyin === null ? (
                MONEY_PLACEHOLDER
              ) : (
                <Money tiyin={props.priceTiyin} size="md" />
              )}
            </Row>
          </div>

          {state === 'expired' || state === 'refreshing' ? (
            <Note icon={RefreshCcw} title={t('expired.title')} body={t('expired.body')} />
          ) : null}
          {state === 'renewed' && total !== null ? (
            <Note
              icon={RefreshCcw}
              title={t('expired.renewedTitle', { total: formatMoney(total) })}
              body={t('expired.renewedBody')}
            />
          ) : null}
          {state === 'failed' && message ? (
            <div
              role="alert"
              className="rounded-2xl bg-danger-soft p-3.5 text-sm leading-5 font-bold text-danger-text"
            >
              <p className="m-0 text-[15px] font-extrabold">{t('failed.title')}</p>
              <p className="m-0 mt-1 font-semibold">{message}</p>
            </div>
          ) : null}

          <div className="flex flex-col gap-2 rounded-2xl bg-muted p-3.5 tabular-nums">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[15px] leading-5 font-extrabold">{t('confirm.total')}</span>
              <span className="text-[22px] leading-7 font-extrabold">
                {total === null || state === 'refreshing' ? (
                  MONEY_PLACEHOLDER
                ) : (
                  <Money tiyin={total} size="lg" />
                )}
              </span>
            </div>
            <div className="flex justify-between gap-3 text-[13px] leading-[18px] font-semibold text-foreground-secondary">
              <span>{t('confirm.balance')}</span>
              <span>{balanceLine}</span>
            </div>
          </div>

          {live && props.msLeft !== null ? (
            <p className="m-0 flex items-center justify-center gap-1.5 text-[13px] leading-[18px] font-semibold text-foreground-muted tabular-nums">
              <Icon icon={Timer} size={14} />
              {t('confirm.ttl', { time: countdown(props.msLeft) })}
            </p>
          ) : null}
          {busy && state === 'refreshing' ? (
            <p
              role="status"
              className="m-0 flex items-center justify-center gap-2 text-[13px] text-foreground-muted"
            >
              <Spinner size={14} />
              {t('expired.renewing')}
            </p>
          ) : null}
        </div>
      )}
    </Sheet>
  );
}

function Note({ icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-2.5 rounded-2xl bg-warning-soft p-3.5 text-warning-text"
    >
      <span className="flex items-center gap-2 text-[15px] leading-5 font-extrabold tabular-nums">
        <Icon icon={icon} size={17} />
        {title}
      </span>
      <span className="text-[13px] leading-[18px] font-semibold text-foreground-secondary">
        {body}
      </span>
    </div>
  );
}
