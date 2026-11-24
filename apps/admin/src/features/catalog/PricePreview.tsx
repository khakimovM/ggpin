import { Skeleton } from '@repo/ui';
import { useQuery } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { isApiError } from '../../lib/api/errors';
import { getPricePreview, type PricePreviewDraft } from '../../lib/api/reads';
import { formatBps, formatCost } from '../../lib/format';
import { qk } from '../../lib/query-keys';
import { KeyValues } from '../common/KeyValues';
import { LoadError } from '../common/ListStates';
import { MoneyCell } from '../common/MoneyCell';
import { Panel } from '../common/Panel';

interface Props {
  productId: string;
  skuId: string | null;
  /**
   * The live preview of an edit (SKU dialog): the proposed markup / minimum margin, already
   * debounced by the caller; null while the typed values are not valid. Absent: the saved price.
   */
  draft?: PricePreviewDraft | null;
}

const NOTE = 'm-0 text-xs leading-4 font-semibold text-foreground-muted';

/**
 * The price of one SKU as the server computes it right now (cost, rate, markup, margin), or with
 * a proposed markup / minimum margin before it is saved. The panel only shows the answer: no price
 * is ever calculated in the browser.
 */
export function PricePreview({ productId, skuId, draft }: Props) {
  const t = useTranslations();
  const live = draft !== undefined;
  const query = useQuery({
    queryKey: [
      ...qk.catalog.pricePreview(productId, skuId ?? ''),
      draft?.markupBps ?? null,
      draft?.minMarginTiyin ?? null,
    ],
    queryFn: ({ signal }) => getPricePreview(productId, skuId ?? '', signal, draft ?? {}),
    enabled: skuId !== null && draft !== null,
  });
  const preview = query.data;
  // 503 PRICE_UNAVAILABLE: no fresh cost or rate (or a package size waiting for its cost sync).
  const unavailable = isApiError(query.error) && query.error.code === 'PRICE_UNAVAILABLE';
  let body;
  if (skuId === null) body = <p className={NOTE}>{t('admin.catalog.preview.pick')}</p>;
  else if (draft === null) body = <p className={NOTE}>{t('admin.catalog.preview.waiting')}</p>;
  else if (preview) {
    body = (
      <>
        <KeyValues
          rows={[
            {
              key: 'cost',
              label: t('admin.catalog.preview.cost'),
              value: formatCost(preview.costCurrency, preview.costMinor),
            },
            {
              key: 'fx',
              label: t('admin.catalog.preview.rate'),
              value: preview.fxRate
                ? `${preview.fxRate.pair.replace('_', '/')} = ${preview.fxRate.rate}`
                : '—',
            },
            {
              key: 'markup',
              label: t('admin.catalog.preview.markup'),
              value: `${formatBps(preview.markupBps)}%`,
            },
            {
              key: 'minMargin',
              label: t('admin.catalog.preview.minMargin'),
              value: <MoneyCell tiyin={preview.minMarginTiyin} />,
            },
            {
              key: 'price',
              label: t('admin.catalog.preview.price'),
              value: <MoneyCell tiyin={preview.priceTiyin} className="text-sm font-extrabold" />,
            },
            {
              key: 'margin',
              label: t('admin.catalog.preview.margin'),
              value: <MoneyCell tiyin={preview.marginTiyin} />,
            },
          ]}
        />
        {preview.belowMinMargin ? (
          <p
            role="alert"
            className="m-0 flex items-center gap-2 rounded-[10px] bg-danger-soft px-3 py-2 text-xs leading-4 font-bold text-danger-text"
          >
            <TriangleAlert size={14} aria-hidden="true" />
            {t('admin.catalog.preview.belowMin')}
          </p>
        ) : (
          <p className="m-0 rounded-[10px] bg-success-soft px-3 py-2 text-xs leading-4 font-bold text-success-text">
            {t('admin.catalog.preview.aboveMin')}
          </p>
        )}
      </>
    );
  } else if (unavailable) {
    body = (
      <p className="m-0 rounded-[10px] bg-warning-soft px-3 py-2 text-xs leading-4 font-bold text-warning-text">
        {t('admin.catalog.preview.unavailable')}
      </p>
    );
  } else if (query.isError) {
    body = (
      <LoadError
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  } else {
    body = (
      <div role="status" aria-label={t('admin.states.loading')}>
        <Skeleton className="h-40 rounded-[10px]" />
      </div>
    );
  }
  return (
    <Panel title={t(live ? 'admin.catalog.preview.live' : 'admin.catalog.preview.title')}>
      <div aria-live={live ? 'polite' : undefined} className="flex flex-col gap-3">
        {body}
      </div>
    </Panel>
  );
}
