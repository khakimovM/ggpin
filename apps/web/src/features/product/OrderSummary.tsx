'use client';

import type { CatalogProductDetail } from '@repo/shared';
import { Button, Icon, Skeleton } from '@repo/ui';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { MONEY_PLACEHOLDER, Money, useFormatMoney } from '../../lib/format/money';
import { useWallet } from '../wallet/use-wallet';
import type { Selection, QuoteView } from './use-quote';

export interface OrderSummaryProps {
  product: CatalogProductDetail;
  selection: Selection | null;
  /** `@username` of the confirmed recipient, else null. */
  recipient: string | null;
  quote: QuoteView;
  onRefreshQuote: () => void;
}

/** 125000 ms -> "02:05". */
export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-foreground-muted">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

/**
 * "Buyurtma xulosasi" (Product.dc.html). The total is the quote's `totalTiyin`, as the server
 * wrote it; before there is one it is a dash or a skeleton, never a figure worked out here. The
 * wallet line is the server's balance; "what is left" is deliberately not shown (that would be
 * a balance computed in the browser, and the purchase itself is checked by the server).
 */
export function OrderSummary({
  product,
  selection,
  recipient,
  quote,
  onRefreshQuote,
}: OrderSummaryProps) {
  const t = useTranslations('store.product');
  const common = useTranslations('common');
  const formatMoney = useFormatMoney();
  const wallet = useWallet();

  const productLabel =
    selection === null
      ? MONEY_PLACEHOLDER
      : selection.kind === 'qty'
        ? t('summary.stars', { count: selection.quantity })
        : (product.skus.find((sku) => sku.id === selection.skuId)?.label ?? MONEY_PLACEHOLDER);

  return (
    <section
      aria-label={t('summary.label')}
      className="flex flex-col gap-2.5 rounded-[24px] border border-border bg-card p-4 text-sm leading-5 font-semibold tabular-nums"
    >
      <Row label={t('summary.product')}>{productLabel}</Row>
      <Row label={t('recipient.summary')}>
        <span className={recipient === null ? 'text-foreground-muted' : undefined}>
          {recipient ?? t('recipient.unconfirmed')}
        </span>
      </Row>
      <Row label={t('delivery.label')}>
        {product.isAuto ? t('delivery.auto') : t('delivery.manual')}
      </Row>
      <div className="my-0.5 h-px bg-border" />
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-extrabold">{t('summary.total')}</span>
        {quote.status === 'ready' && !quote.expired ? (
          <Money tiyin={quote.quote.totalTiyin} size="lg" />
        ) : quote.status === 'pending' ? (
          <Skeleton className="h-[26px] w-28 rounded-xs" />
        ) : (
          <span className="text-xl leading-[26px] font-extrabold text-foreground-muted">
            {MONEY_PLACEHOLDER}
          </span>
        )}
      </div>

      <div role="status" aria-live="polite" className="text-[13px] leading-[18px] font-medium">
        {quote.status === 'pending' ? (
          <span className="text-foreground-muted">{t('quote.pending')}</span>
        ) : null}
        {quote.status === 'ready' && !quote.expired ? (
          <span className="text-foreground-muted">
            {t('quote.valid', { time: formatClock(quote.msLeft) })}
          </span>
        ) : null}
      </div>

      {quote.status === 'ready' && quote.expired ? (
        <QuoteNote tone="warning" text={t('quote.expired')}>
          <Button variant="outline" size="sm" onClick={onRefreshQuote}>
            <Icon icon={RefreshCw} size={14} />
            {t('quote.refresh')}
          </Button>
        </QuoteNote>
      ) : null}
      {quote.status === 'unavailable' || quote.status === 'failed' ? (
        <QuoteNote
          tone="warning"
          text={quote.status === 'unavailable' ? t('quote.unavailable') : t('quote.failed')}
        >
          <Button variant="outline" size="sm" onClick={onRefreshQuote}>
            {common('retry')}
          </Button>
        </QuoteNote>
      ) : null}
      {quote.status === 'productChanged' ? (
        <QuoteNote tone="warning" text={t('quote.changed')}>
          <Button variant="outline" size="sm" onClick={onRefreshQuote}>
            {t('quote.refresh')}
          </Button>
        </QuoteNote>
      ) : null}
      {quote.status === 'rateLimited' ? (
        <QuoteNote tone="info" text={t('quote.rateLimited', { seconds: quote.retryInSec })} />
      ) : null}

      {wallet.data ? (
        <div className="text-[13px] text-foreground-muted">
          {t('summary.wallet', { amount: formatMoney(wallet.data.balanceTiyin) })}
        </div>
      ) : null}
    </section>
  );
}

function QuoteNote({
  tone,
  text,
  children,
}: {
  tone: 'warning' | 'info';
  text: string;
  children?: ReactNode;
}) {
  return (
    <div
      role="alert"
      className={`flex items-center gap-2.5 rounded-[14px] py-2.5 pr-2.5 pl-3 text-[13px] leading-[18px] font-bold ${tone === 'warning' ? 'bg-warning-soft text-warning-text' : 'bg-info-soft text-info-text'}`}
    >
      <Icon icon={TriangleAlert} size={16} className="shrink-0" />
      <span className="min-w-0 flex-1">{text}</span>
      {children}
    </div>
  );
}
