import type { AdminDashboardResponse } from '@repo/shared';
import { AreaChart, BarChart, DonutChart } from '@repo/ui';
import { useTranslations } from 'use-intl';
import { formatCount, type CompactSom } from '../../lib/format';
import { Panel } from '../common/Panel';
import { axisValues, bankBars, lossDays, productSlices, revenueChart } from './dashboard-model';

function Legend({ label, tone }: { label: string; tone: 'bg-chart-1' | 'bg-chart-3' }) {
  return (
    <span className="flex items-center gap-[5px]">
      <span className={`h-[3px] w-2.5 rounded-[2px] ${tone}`} />
      {label}
    </span>
  );
}

function NoData({ text }: { text?: string }) {
  const t = useTranslations();
  return (
    <p className="m-0 py-8 text-center text-xs leading-4 font-semibold text-foreground-muted">
      {text ?? t('admin.dashboard.charts.noData')}
    </p>
  );
}

interface Props {
  charts: AdminDashboardResponse['charts'];
  /** The "today" period: one daily point, so the chart gives way to a hint. */
  today: boolean;
}

/**
 * The chart row of the dashboard: revenue and profit, product share, top-ups by bank. The API's
 * revenue series is daily, so "today" (one point) gets a hint to pick a longer period (R-3); the
 * design's hourly chart has no API behind it yet.
 */
export function DashboardCharts({ charts, today }: Props) {
  const t = useTranslations();
  const axis = (value: CompactSom) =>
    value.unit === 'none'
      ? value.value
      : t(`admin.dashboard.charts.${value.unit}`, { value: value.value });
  const revenue = revenueChart(charts.revenue);
  const losses = lossDays(charts.revenue);
  const [top, middle] = axisValues(revenue.top);
  const products = productSlices(charts.productShare);
  const som = t('admin.money.som');
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <Panel
        title={t('admin.dashboard.charts.revenue')}
        aside={
          <span className="flex gap-3 text-[11px] leading-[14px] font-bold text-foreground-secondary">
            <Legend label={t('admin.dashboard.charts.revenueLegend')} tone="bg-chart-1" />
            <Legend label={t('admin.dashboard.charts.profitLegend')} tone="bg-chart-3" />
          </span>
        }
      >
        {today ? (
          <NoData text={t('admin.dashboard.charts.todayHint')} />
        ) : charts.revenue.length < 2 ? (
          <NoData />
        ) : (
          <>
            <AreaChart
              label={t('admin.dashboard.charts.revenue')}
              series={revenue.series}
              yLabels={[axis(top), axis(middle), '0']}
              xLabels={revenue.xLabels}
            />
            {losses.length > 0 ? (
              <p className="m-0 text-[11px] leading-[14px] font-semibold text-danger-text tabular-nums">
                {t('admin.dashboard.charts.lossDays', { days: losses.join(' · '), som })}
              </p>
            ) : null}
          </>
        )}
      </Panel>
      <Panel title={t('admin.dashboard.charts.products')}>
        {products.total === 0 ? (
          <NoData />
        ) : (
          <DonutChart
            label={t('admin.dashboard.charts.products')}
            slices={products.slices}
            total={formatCount(products.total)}
            totalCaption={t('admin.dashboard.charts.ordersCaption')}
          />
        )}
      </Panel>
      <Panel title={t('admin.dashboard.charts.banks')}>
        {charts.topupBankShare.length === 0 ? (
          <NoData />
        ) : (
          <BarChart
            label={t('admin.dashboard.charts.banks')}
            rows={bankBars(charts.topupBankShare, som)}
          />
        )}
      </Panel>
    </div>
  );
}
