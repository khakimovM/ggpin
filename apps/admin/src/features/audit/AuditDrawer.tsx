import type { AdminAuditRow } from '@repo/shared';
import { Drawer, Skeleton, cn } from '@repo/ui';
import { useTranslations } from 'use-intl';
import { formatDateTime } from '../../lib/format';
import { KeyValues } from '../common/KeyValues';
import { Tag } from '../common/Tag';
import { auditDiff } from './audit-diff';

interface Props {
  entry: AdminAuditRow | undefined;
  /** The list page is still loading: the entry may be on it (R-6), so no "not on page" yet. */
  loading: boolean;
  open: boolean;
  onClose: () => void;
}

const LINE = {
  '+': 'bg-success-soft text-success-text',
  '-': 'bg-danger-soft text-danger-text',
  ' ': 'text-foreground-secondary',
} as const;

/** One audit entry: who, what, why, and the before / after diff (plain text lines). */
export function AuditDrawer({ entry, loading, open, onClose }: Props) {
  const t = useTranslations();
  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={entry ? entry.action : t('admin.audit.title')}
      badge={entry ? <Tag tone="mute">{entry.actor.type}</Tag> : null}
      closeLabel={t('admin.dialogs.close')}
    >
      {entry ? (
        <>
          <KeyValues
            rows={[
              {
                key: 'time',
                label: t('admin.audit.col.time'),
                value: formatDateTime(entry.createdAt),
              },
              {
                key: 'actor',
                label: t('admin.audit.col.actor'),
                value: entry.actor.name ?? t(`admin.audit.actor.${entry.actor.type}`),
              },
              {
                key: 'target',
                label: t('admin.audit.col.target'),
                value: `${entry.targetType} · ${entry.targetId}`,
              },
              { key: 'reason', label: t('admin.audit.col.reason'), value: entry.reason ?? '—' },
              { key: 'ip', label: t('admin.list.col.ip'), value: entry.ip ?? '—' },
            ]}
          />
          <h3 className="m-0 text-[13px] leading-[18px] font-extrabold">
            {t('admin.audit.changes', { action: entry.action })}
          </h3>
          {entry.before === null && entry.after === null ? (
            <p className="m-0 text-xs leading-4 font-semibold text-foreground-muted">
              {t('admin.audit.noChanges')}
            </p>
          ) : (
            <pre
              aria-label={t('admin.audit.diff')}
              tabIndex={0}
              className="m-0 overflow-auto rounded-[10px] border border-border bg-surface py-2 font-mono text-xs leading-5"
            >
              {auditDiff(entry.before, entry.after).map((line, index) => (
                <span
                  key={`${line.key}-${index}`}
                  className={cn('block px-3 whitespace-pre-wrap break-all', LINE[line.sign])}
                >
                  {`${line.sign} ${line.key}: ${line.value}`}
                </span>
              ))}
            </pre>
          )}
        </>
      ) : loading ? (
        <div role="status" aria-label={t('admin.states.loading')} className="flex flex-col gap-2">
          <Skeleton className="h-40 rounded-[10px]" />
          <Skeleton className="h-24 rounded-[10px]" />
        </div>
      ) : (
        <p className="m-0 text-xs leading-4 font-semibold text-foreground-muted">
          {t('admin.audit.notOnPage')}
        </p>
      )}
    </Drawer>
  );
}
