import { KpiCard, Skeleton } from '@repo/ui';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDownToLine,
  CircleCheck,
  ShoppingBag,
  Timer,
  TrendingUp,
  UserPlus,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'use-intl';
import { getDashboard } from '../../lib/api/reads';
import { useListParams } from '../../lib/list-params';
import { qk } from '../../lib/query-keys';
import { FilterPills } from '../common/FilterPills';
import { LoadError } from '../common/ListStates';
import { PageHeader } from '../common/PageHeader';
import { SectionGate } from '../common/SectionGate';
import { AlertsPanel } from './AlertsPanel';
import { DashboardCharts } from './DashboardCharts';
import { DASHBOARD_PERIOD_IDS, durationParts, kpiViews, type KpiView } from './dashboard-model';

const SPEC = { period: { default: 'today', values: DASHBOARD_PERIOD_IDS } } as const;

const KPI_ICON: Record<KpiView['id'], LucideIcon> = {
  revenue: TrendingUp,
  profit: Wallet,
  orders: ShoppingBag,
  deliveryRate: CircleCheck,
  avgDelivery: Timer,
  newUsers: UserPlus,
  topups: ArrowDownToLine,
};

function Dashboard() {
  const t = useTranslations();
  const { values, set } = useListParams(SPEC);
  const query = useQuery({
    queryKey: qk.dashboard.summary(values.period),
    queryFn: ({ signal }) => getDashboard(values.period, signal),
    refetchInterval: 60_000,
  });
  const data = query.data;
  const avg = data?.kpi.avgDeliverySec;
  const avgText =
    avg === null || avg === undefined ? '—' : t('admin.dashboard.duration', durationParts(avg));
  return (
    <>
      <PageHeader
        title={t('admin.nav.dashboard')}
        actions={
          <FilterPills
            label={t('admin.dashboard.period.label')}
            value={values.period}
            onChange={(period) => set({ period })}
            options={DASHBOARD_PERIOD_IDS.map((id) => ({
              value: id,
              label: t(`admin.dashboard.period.${id}`),
            }))}
          />
        }
      />
      {data === undefined ? (
        query.isError ? (
          <div className="rounded-md border border-border bg-card">
            <LoadError
              error={query.error}
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
            />
          </div>
        ) : (
          <div role="status" aria-label={t('admin.states.loading')} className="flex flex-col gap-3">
            <Skeleton className="h-[100px] rounded-md" />
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2.5">
              {Array.from({ length: 7 }, (_, index) => (
                <Skeleton key={index} className="h-[76px] rounded-md" />
              ))}
            </div>
            <Skeleton className="h-[260px] rounded-md" />
          </div>
        )
      ) : (
        <>
          <AlertsPanel alerts={data.alerts} updatedAt={query.dataUpdatedAt} />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2.5">
            {kpiViews(data.kpi).map((kpi) => (
              <KpiCard
                key={kpi.id}
                label={t(`admin.dashboard.kpi.${kpi.id}`)}
                icon={KPI_ICON[kpi.id]}
                tone={kpi.tone}
                value={kpi.id === 'avgDelivery' ? avgText : kpi.value}
                unit={
                  kpi.unit === 'som'
                    ? ` ${t('admin.money.som')}`
                    : kpi.unit === 'percent'
                      ? '%'
                      : undefined
                }
              />
            ))}
          </div>
          <DashboardCharts charts={data.charts} today={values.period === 'today'} />
        </>
      )}
    </>
  );
}

export function DashboardPage() {
  const t = useTranslations();
  return (
    <SectionGate permission="dashboard.read" title={t('admin.nav.dashboard')}>
      <Dashboard />
    </SectionGate>
  );
}
