import { Skeleton } from '@repo/ui';
import { useQuery } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { getPricePreview } from '../../lib/api/reads';
import { formatBps, formatCost } from '../../lib/format';
import { qk } from '../../lib/query-keys';
import { KeyValues } from '../common/KeyValues';
import { LoadError } from '../common/ListStates';
import { MoneyCell } from '../common/MoneyCell';
import { Panel } from '../common/Panel';

interface Props {
  productId: string;
  skuId: string | null;
}

/**
 * The price of one SKU as the server computes it right now (cost, rate, markup, margin). The
 * panel only shows the answer: no price is ever calculated in the browser.
 */
export function PricePreview({ productId, skuId }: Props) {
  const t = useTranslations();
  const query = useQuery({
    queryKey: qk.catalog.pricePreview(productId, skuId ?? ''),
    queryFn: ({ signal }) => getPricePreview(productId, skuId ?? '', signal),
    enabled: skuId !== null,
  });
  const preview = query.data;
  return (
    <Panel title={t('admin.catalog.preview.title')}>
      {skuId === null ? (
        <p className="m-0 text-xs leading-4 font-semibold text-foreground-muted">
          {t('admin.catalog.preview.pick')}
        </p>
      ) : preview ? (
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
                value: preview.fxRate ? `${preview.fxRate.pair} = ${preview.fxRate.rate}` : '—',
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
      ) : query.isError ? (
        <LoadError
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : (
        <div role="status" aria-label={t('admin.states.loading')}>
          <Skeleton className="h-40 rounded-[10px]" />
        </div>
      )}
    </Panel>
  );
}
