import type { AdminDashboardResponse } from '@repo/shared';
import { FOCUS_RING, Icon, cn } from '@repo/ui';
import {
  CircleCheck,
  FileWarning,
  Gem,
  GitCompare,
  KeyRound,
  Layers,
  Radio,
  ScanSearch,
  Siren,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router';
import { useTranslations } from 'use-intl';
import { formatTime } from '../../lib/format';
import {
  ALERT_LINK,
  alertTone,
  sinceLabel,
  type AlertKind,
  type AlertTone,
} from './dashboard-model';
import { camelKey } from '../../lib/camel-key';

const ICON: Record<AlertKind, LucideIcon> = {
  ORDERS_NEEDS_REVIEW: ScanSearch,
  ORDERS_HELD: ScanSearch,
  PAYMENT_REVIEWS_OPEN: FileWarning,
  FRAGMENT_SESSION_DEAD: KeyRound,
  TON_BALANCE_LOW: Gem,
  TON_DAILY_LIMIT_HIGH: Gem,
  QUEUE_FAILED_JOBS: Layers,
  RECONCILE_MISMATCH: GitCompare,
  BANK_FEED_SILENT: Radio,
};

const TILE: Record<AlertTone, string> = {
  warn: 'bg-warning-soft text-warning-text',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
};

interface Props {
  alerts: AdminDashboardResponse['alerts'];
  /** When the dashboard was fetched (ms), for "Yangilandi: 14:12:04". */
  updatedAt: number;
}

/** "Ogohlantirishlar" (Admin.dc.html): five columns on a desktop, one column on a tablet. */
export function AlertsPanel({ alerts, updatedAt }: Props) {
  const t = useTranslations();
  const updatedIso = new Date(updatedAt).toISOString();
  return (
    <section
      aria-labelledby="alerts-title"
      className="overflow-hidden rounded-md border border-border bg-card"
    >
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5 text-[13px] leading-[18px] font-extrabold">
        <Icon icon={Siren} size={15} className="text-danger" />
        <h2 id="alerts-title" className="m-0 text-[13px] leading-[18px] font-extrabold">
          {t('admin.dashboard.alerts.title')}
        </h2>
        {alerts.length > 0 ? (
          <span className="h-[18px] rounded-full bg-danger-soft px-1.5 text-[10px] leading-[18px] font-extrabold text-danger-text">
            {alerts.length}
          </span>
        ) : null}
        <span className="ml-auto text-[11px] leading-4 font-semibold text-foreground-muted tabular-nums">
          {t('admin.dashboard.updated', { time: formatTime(updatedIso) })}
        </span>
      </div>
      {alerts.length === 0 ? (
        <p className="m-0 flex items-center gap-2.5 px-3.5 py-3 text-xs leading-[17px] font-bold">
          <span className="grid size-7 place-items-center rounded-badge bg-success-soft text-success">
            <Icon icon={CircleCheck} size={14} />
          </span>
          {t('admin.dashboard.alerts.none')}
        </p>
      ) : (
        <ul className="m-0 grid list-none grid-cols-1 p-0 xl:grid-cols-5">
          {alerts.map((alert) => {
            const tone = alertTone(alert);
            return (
              <li
                key={alert.kind}
                className={cn(
                  'flex items-start gap-2.5 border-t border-border px-3.5 py-3 first:border-t-0',
                  'xl:border-t-0 xl:border-l xl:first:border-l-0',
                  tone === 'danger' && 'bg-danger-soft/45',
                )}
              >
                <span
                  className={cn(
                    'grid size-7 flex-none place-items-center rounded-badge',
                    TILE[tone],
                  )}
                >
                  <Icon icon={ICON[alert.kind]} size={14} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="text-xs leading-[17px] font-bold text-pretty tabular-nums">
                    {t(`admin.dashboard.alerts.kind.${camelKey(alert.kind)}`, {
                      count: alert.count ?? 0,
                    })}
                  </span>
                  {alert.since ? (
                    <span className="text-[11px] leading-[14px] font-semibold text-foreground-muted tabular-nums">
                      {t('admin.dashboard.alerts.since', {
                        time: sinceLabel(alert.since, updatedIso),
                      })}
                    </span>
                  ) : null}
                  <Link
                    to={ALERT_LINK[alert.kind]}
                    className={cn(
                      'self-start rounded-xs text-[11px] leading-[14px] font-extrabold text-primary-soft-foreground no-underline hover:underline',
                      FOCUS_RING,
                    )}
                  >
                    {t(`admin.dashboard.alerts.cta.${camelKey(alert.kind)}`)} →
                  </Link>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
