import { ADMIN_FX_PAIRS, type AdminFxRate } from '@repo/shared';
import { AreaChart, DataTable, type DataTableColumn } from '@repo/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { LineChart } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { listFxHistory } from '../../lib/api/reads';
import { formatDateTime } from '../../lib/format';
import { useListParams } from '../../lib/list-params';
import { qk } from '../../lib/query-keys';
import { FilterPills } from '../common/FilterPills';
import { ListEmpty, LoadError } from '../common/ListStates';
import { Pager } from '../common/Pager';
import { Panel } from '../common/Panel';
import { tableState } from '../common/table-state';
import { rateSeries } from './pricing-model';

const SPEC = { pair: { default: 'USDT_UZS', values: ADMIN_FX_PAIRS } } as const;

/** "Kurs manbalari": the stored FX snapshots of one pair, a line of the latest page and the list. */
export function FxHistory() {
  const t = useTranslations();
  const { values, page, set, setPage } = useListParams(SPEC);
  const params = { pair: values.pair, page, limit: 20 };
  const query = useQuery({
    queryKey: qk.settings.fxHistory(params),
    queryFn: ({ signal }) => listFxHistory(params, signal),
    placeholderData: keepPreviousData,
  });
  const rows = query.data?.items;
  const series = rows && rows.length > 1 ? rateSeries(rows) : null;
  const columns: DataTableColumn<AdminFxRate>[] = [
    {
      id: 'time',
      header: t('admin.pricing.fx.time'),
      cell: (row) => formatDateTime(row.createdAt),
    },
    {
      id: 'rate',
      header: t('admin.pricing.fx.rate'),
      align: 'end',
      cell: (row) => row.rate,
      className: 'font-extrabold',
    },
    {
      id: 'source',
      header: t('admin.pricing.fx.source'),
      cell: (row) => row.source,
      className: 'text-foreground-secondary',
    },
  ];
  return (
    <Panel
      title={t('admin.pricing.fx.title')}
      aside={
        <FilterPills
          label={t('admin.pricing.fx.pair')}
          value={values.pair}
          onChange={(pair) => set({ pair })}
          options={ADMIN_FX_PAIRS.map((pair) => ({ value: pair, label: pair.replace('_', '/') }))}
        />
      }
    >
      {series ? (
        <AreaChart
          label={t('admin.pricing.fx.chart', { pair: values.pair })}
          series={[{ id: 'rate', ratios: series.ratios, tone: 1, fillOpacity: 0.12 }]}
          yLabels={series.yLabels}
          xLabels={series.xLabels}
          height={140}
        />
      ) : null}
      <DataTable
        label={t('admin.pricing.fx.title')}
        columns={columns}
        rows={rows ?? []}
        rowKey={(row) => row.id}
        state={tableState(query, rows?.length)}
        framed={false}
        skeletonRows={4}
        loadingLabel={t('admin.states.loading')}
        empty={<ListEmpty icon={LineChart} title={t('admin.pricing.fx.empty')} />}
        error={
          <LoadError
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        }
        footer={
          query.data && query.data.meta.total > 0 ? (
            <Pager meta={query.data.meta} onPage={setPage} />
          ) : null
        }
      />
    </Panel>
  );
}
