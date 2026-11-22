import type { AdminSettingsResponse } from '@repo/shared';
import { Skeleton } from '@repo/ui';
import { useQuery } from '@tanstack/react-query';
import { SlidersHorizontal } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { getSettings } from '../../lib/api/reads';
import { formatBps, formatCount } from '../../lib/format';
import { qk } from '../../lib/query-keys';
import { ListEmpty, LoadError } from '../common/ListStates';
import { MoneyCell } from '../common/MoneyCell';
import { PageHeader } from '../common/PageHeader';
import { Panel } from '../common/Panel';
import { SectionGate } from '../common/SectionGate';
import { Tag } from '../common/Tag';
import { FxHistory } from './FxHistory';
import { SETTING_GROUPS } from './pricing-model';
import { camelKey } from '../../lib/camel-key';

type Setting = AdminSettingsResponse['items'][number];

function SettingValue({ setting }: { setting: Setting }) {
  const t = useTranslations();
  if (setting.unit === 'TIYIN') return <MoneyCell tiyin={setting.value} />;
  if (setting.unit === 'BPS') return <>{formatBps(Number(setting.value))}%</>;
  if (setting.unit === 'MS') {
    const seconds = Math.round(Number(setting.value) / 1000);
    return (
      <>
        {seconds % 60 === 0
          ? t('admin.pricing.minutes', { count: seconds / 60 })
          : t('admin.pricing.seconds', { count: seconds })}
      </>
    );
  }
  return <>{formatCount(Number(setting.value))}</>;
}

function Settings() {
  const t = useTranslations();
  const query = useQuery({
    queryKey: qk.settings.values(),
    queryFn: ({ signal }) => getSettings(signal),
  });
  const items = query.data?.items;
  return (
    <>
      <PageHeader title={t('admin.nav.pricing')} sub={t('admin.pricing.sub')} />
      {items && items.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
          {SETTING_GROUPS.map((group) => (
            <Panel key={group.id} title={t(`admin.pricing.group.${group.id}`)}>
              <ul className="m-0 flex list-none flex-col p-0">
                {group.keys.flatMap((key) => {
                  const setting = items.find((item) => item.key === key);
                  if (setting === undefined) return [];
                  return [
                    <li
                      key={key}
                      className="flex items-start justify-between gap-3 border-t border-border py-2.5 first:border-t-0 first:pt-0"
                    >
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-xs leading-4 font-bold">
                          {t(`admin.pricing.setting.${camelKey(key)}`)}
                        </span>
                        <span className="font-mono text-[10px] leading-3 text-foreground-muted">
                          {key}
                        </span>
                      </span>
                      <span className="flex flex-none flex-col items-end gap-1 text-[13px] leading-[18px] font-extrabold tabular-nums">
                        <SettingValue setting={setting} />
                        <Tag tone="mute">{t(`admin.pricing.source.${setting.source}`)}</Tag>
                      </span>
                    </li>,
                  ];
                })}
              </ul>
            </Panel>
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-border bg-card py-6">
          {items ? (
            <ListEmpty icon={SlidersHorizontal} title={t('admin.pricing.empty')} />
          ) : query.isError ? (
            <LoadError
              error={query.error}
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
            />
          ) : (
            <div
              role="status"
              aria-label={t('admin.states.loading')}
              className="grid gap-3 px-3.5 xl:grid-cols-3"
            >
              <Skeleton className="h-60 rounded-md" />
              <Skeleton className="h-60 rounded-md" />
              <Skeleton className="h-60 rounded-md" />
            </div>
          )}
        </div>
      )}
      <FxHistory />
    </>
  );
}

export function PricingPage() {
  const t = useTranslations();
  return (
    <SectionGate permission="settings.read" title={t('admin.nav.pricing')}>
      <Settings />
    </SectionGate>
  );
}
