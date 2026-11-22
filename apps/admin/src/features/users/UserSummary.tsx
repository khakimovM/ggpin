import type { AdminUserDetailResponse } from '@repo/shared';
import { Avatar } from '@repo/ui';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslations } from 'use-intl';
import { formatCount, formatDate, formatDateTime } from '../../lib/format';
import { KeyValues } from '../common/KeyValues';
import { MoneyCell } from '../common/MoneyCell';
import { Panel } from '../common/Panel';
import { PendingActions } from '../common/PendingActions';
import { Tag } from '../common/Tag';
import { TEXT_LINK } from '../common/link-style';
import { USER_STATUS_TONE, userStatus } from './user-status';
import { camelKey } from '../../lib/camel-key';

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[10px] bg-surface px-3 py-2.5">
      <span className="text-[11px] leading-[14px] font-bold text-foreground-muted">{label}</span>
      <span className="text-base leading-5 font-extrabold tabular-nums">{children}</span>
    </div>
  );
}

/** The head of a user's page (AdminOps.dc.html `user`): who, state, figures, actions, facts. */
export function UserSummary({ user }: { user: AdminUserDetailResponse }) {
  const t = useTranslations();
  const status = userStatus(user);
  const name =
    [user.firstName, user.lastName].filter(Boolean).join(' ') ||
    (user.username ? `@${user.username}` : user.telegramId);
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <Panel>
        <div className="flex flex-wrap items-center gap-3">
          <Avatar name={name} size={56} />
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="m-0 text-[22px] leading-7 font-extrabold tracking-[-.01em]">{name}</h1>
            <span className="text-xs leading-4 font-semibold text-foreground-muted tabular-nums">
              {t('admin.users.detail.handle', {
                username: user.username ? `@${user.username}` : '—',
                id: user.telegramId,
              })}
            </span>
            <span className="flex flex-wrap gap-1.5">
              <Tag tone={USER_STATUS_TONE[status]}>
                {t(`admin.users.status.${camelKey(status)}`)}
              </Tag>
              <Tag tone="mute">{t(`admin.users.locale.${user.locale}`)}</Tag>
            </span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Stat label={t('admin.users.col.balance')}>
            <MoneyCell tiyin={user.balanceTiyin} />
          </Stat>
          <Stat label={t('admin.users.detail.spent')}>
            <MoneyCell tiyin={user.ordersTotalTiyin} />
          </Stat>
          <Stat label={t('admin.users.col.orders')}>{formatCount(user.ordersCount)}</Stat>
          <Stat label={t('admin.users.col.referrals')}>{formatCount(user.referralsCount)}</Stat>
        </div>
        <PendingActions
          labels={[
            t('admin.users.actions.block'),
            t('admin.users.actions.freeze'),
            t('admin.users.actions.adjust'),
            t('admin.users.actions.sessions'),
          ]}
        />
      </Panel>
      <Panel title={t('admin.users.detail.facts')}>
        <KeyValues
          rows={[
            { key: 'phone', label: t('admin.users.detail.phone'), value: user.phone ?? '—' },
            {
              key: 'created',
              label: t('admin.users.col.created'),
              value: formatDate(user.createdAt),
            },
            {
              key: 'seen',
              label: t('admin.users.col.lastSeen'),
              value: user.lastSeenAt ? formatDateTime(user.lastSeenAt) : '—',
            },
            { key: 'code', label: t('admin.users.detail.referralCode'), value: user.referralCode },
            {
              key: 'by',
              label: t('admin.users.detail.referredBy'),
              value: user.referredBy ? (
                <Link to={`/users/${user.referredBy.id}`} className={TEXT_LINK}>
                  {user.referredBy.username ? `@${user.referredBy.username}` : user.referredBy.id}
                </Link>
              ) : (
                '—'
              ),
            },
            {
              key: 'sessions',
              label: t('admin.users.detail.activeSessions'),
              value: formatCount(user.activeSessionsCount),
            },
          ]}
        />
      </Panel>
    </div>
  );
}
