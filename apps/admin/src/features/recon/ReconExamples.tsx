import type { ReconcileMismatchCode } from '@repo/shared';
import { cn } from '@repo/ui';
import { Link } from 'react-router';
import { useTranslations } from 'use-intl';
import { useDrawerParam } from '../../lib/drawer-param';
import { TEXT_LINK } from '../common/link-style';

/**
 * What the example ids of each mismatch code are (the worker's reconcile checks, R-13): bank
 * message ids open the message drawer on this screen, review ids the review drawer on the payments
 * screen; payment and intent ids have no detail screen yet and stay plain text.
 */
const TARGET: Record<ReconcileMismatchCode, 'message' | 'review' | null> = {
  recovered: 'message',
  missingOutcome: 'message',
  creditUnaccounted: 'message',
  chainBreak: 'message',
  purgeOverdue: 'message',
  reviewOpenOver24h: 'review',
  paymentWithoutMessage: null,
  pendingPastGrace: null,
  lateOverLimit: null,
};

interface Props {
  code: ReconcileMismatchCode;
  ids: readonly string[];
}

/** "Misollar: mkmsg000007, …": each id a link to its detail where one exists. */
export function ReconExamples({ code, ids }: Props) {
  const t = useTranslations();
  const message = useDrawerParam('message');
  const target = TARGET[code];
  return (
    <span className="flex flex-wrap items-baseline gap-x-1.5 font-mono text-[11px] leading-4 break-all text-foreground-secondary">
      <span className="font-sans font-semibold">{t('admin.recon.examples')}</span>
      {ids.map((id) =>
        target === 'message' ? (
          <button
            key={id}
            type="button"
            onClick={() => message.open(id)}
            className={cn(TEXT_LINK, 'font-mono')}
          >
            {id}
          </button>
        ) : target === 'review' ? (
          <Link
            key={id}
            to={`/payments?review=${encodeURIComponent(id)}`}
            className={cn(TEXT_LINK, 'font-mono')}
          >
            {id}
          </Link>
        ) : (
          <span key={id}>{id}</span>
        ),
      )}
    </span>
  );
}
