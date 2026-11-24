import { Icon, cn } from '@repo/ui';
import { CircleHelp } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { pendingAttemptMark } from '../../lib/idempotency';
import type { AppliedOutcome } from '../../lib/idempotency-outcome';
import type { BlockingOpposite } from '../../lib/opposite-actions';
import { NOTICE_BOX } from './notice-box';
import { OutcomeCheck } from './OutcomeCheck';

interface Props {
  opposite: BlockingOpposite;
  busy: boolean;
  onApplied: (applied: AppliedOutcome) => void;
  onVoided: () => void;
}

/**
 * The lock of an action whose opposite on the same target may still commit (SA L-2, L-4): names
 * that action and, when its outcome is unknown, offers ITS key void here. While its attempt is
 * still out no void is offered (none is sent then, N-1): only its answer can end the wait.
 */
export function OppositeNotice({ opposite, busy, onApplied, onVoided }: Props) {
  const t = useTranslations();
  return (
    <div role="status" className={cn(NOTICE_BOX, 'flex-col bg-warning-soft text-warning-text')}>
      <span className="flex items-start gap-2">
        <Icon icon={CircleHelp} size={16} className="mt-px flex-none" />
        {opposite.waiting === 'outcome'
          ? t('admin.dialogs.oppositeUnknown', { action: t(opposite.side.titleKey) })
          : t('admin.dialogs.oppositeInFlight', { action: t(opposite.side.titleKey) })}
      </span>
      {opposite.waiting === 'outcome' ? (
        <OutcomeCheck
          key={pendingAttemptMark(opposite.action) ?? 'none'}
          action={opposite.action}
          busy={busy}
          onApplied={onApplied}
          onVoided={onVoided}
        />
      ) : null}
    </div>
  );
}
