'use client';

import type { SessionItem } from '@repo/shared';
import { Button, Icon, cn } from '@repo/ui';
import { Laptop, Monitor, Smartphone } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '../../lib/format/use-date-format';
import { describeUserAgent } from './describe-user-agent';

const ICONS = { mobile: Smartphone, laptop: Laptop, desktop: Monitor } as const;

interface Props {
  session: SessionItem;
  first: boolean;
  revoking: boolean;
  /** Another session may be ending; every end button waits for it (one request at a time). */
  busy: boolean;
  onRevoke: (id: string) => void;
}

/** One device of Store.dc.html "Faol sessiyalar": icon, "Chrome · Windows", where and when. */
export function SessionRow({ session, first, revoking, busy, onRevoke }: Props) {
  const t = useTranslations('web.sessions');
  const { userDateTime } = useDateFormat();
  const device = describeUserAgent(session.userAgent);
  const name = device.label ?? t('unknownDevice');
  const when = session.current ? t('activeNow') : userDateTime(new Date(session.lastUsedAt));
  const meta = [session.ipMasked, when].filter((part) => part !== null).join(' · ');

  return (
    <li className={cn('flex items-center gap-3 py-3', !first && 'border-t border-border')}>
      <span className="grid size-10 flex-none place-items-center rounded-control bg-muted text-foreground-secondary">
        <Icon icon={ICONS[device.kind]} size={18} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2 text-sm leading-[19px] font-extrabold">
          {name}
          {session.current ? (
            <span className="inline-flex h-5 items-center rounded-badge bg-success-soft px-[7px] text-[10px] font-extrabold text-success-text">
              {t('current')}
            </span>
          ) : null}
        </span>
        <span className="text-xs leading-4 font-semibold text-foreground-muted">{meta}</span>
      </span>
      {session.current ? null : (
        <Button
          variant="outline"
          size="sm"
          className="text-danger-text hover:border-danger hover:bg-danger-soft"
          loading={revoking}
          disabled={busy && !revoking}
          aria-label={t('endLabel', { device: name })}
          onClick={() => onRevoke(session.id)}
        >
          {t('end')}
        </Button>
      )}
    </li>
  );
}
