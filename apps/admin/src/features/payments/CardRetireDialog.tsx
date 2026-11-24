import type { AdminCard } from '@repo/shared';
import { Archive } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { requestConfirmation } from '../../lib/api/confirmations';
import { changeCard } from '../../lib/api/writes-payments';
import { pendingFields } from '../../lib/idempotency';
import { CheckField } from '../common/CheckField';
import { ConfirmCodeStep } from '../common/ConfirmCodeStep';
import { ReasonDialog } from '../common/ReasonDialog';
import { useAdminAction } from '../common/use-admin-action';
import { useCodeStep } from '../common/use-code-step';
import { cancelledDetail, cardLabel } from './card-text';
import { NotSentError } from '../../lib/api/errors';

interface Props {
  card: AdminCard;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CardRetireDialog(props: Props) {
  return props.open ? <CardRetireOpen {...props} /> : null;
}

/**
 * card:retire (OWNER, code always — owner decision 2026-11-18). Plain: DRAINING, issued requests
 * stay payable; emergency: RETIRED now and its pending requests cancelled. The flag is bound.
 */
function CardRetireOpen({ card, onOpenChange }: Props) {
  const t = useTranslations();
  const act = useAdminAction();
  const action = act.idOf('cards.retire', card.id);
  const [sent] = useState(() => pendingFields(action));
  const [emergency, setEmergency] = useState(sent?.emergency === true);
  const confirmation = { action: 'cards.retire' as const, targetId: card.id, emergency };
  const code = useCodeStep(confirmation);
  return (
    <ReasonDialog
      action={action}
      open
      onOpenChange={onOpenChange}
      title={t('admin.payments.cards.dialog.retire.title')}
      description={t('admin.payments.cards.dialog.retire.body', { card: cardLabel(card) })}
      icon={Archive}
      tone="danger"
      submitLabel={t('admin.payments.cards.dialog.retire.cta')}
      actor={act.actor}
      extraValid={code.otp !== null}
      fields={{ emergency }}
      onOutcomeFound={(applied) => act.found('cards.retire', applied)}
      onRestart={code.reset}
      onSubmit={async ({ reason, idempotencyKey }) => {
        if (code.otp === null) throw new NotSentError();
        try {
          const result = await changeCard(
            card.id,
            { action: 'cards.retire', body: { reason, emergency, otp: code.otp } },
            idempotencyKey,
          );
          act.finished('cards.retire', result, cancelledDetail(t, result.cancelledIntents));
        } catch (error) {
          code.refused(error);
          throw error;
        }
      }}
    >
      <div className="flex flex-col gap-1">
        <CheckField
          label={t('admin.payments.cards.emergency')}
          checked={emergency}
          onChange={setEmergency}
          tone="warning"
        />
        <span className="text-[11px] leading-[15px] font-semibold text-foreground-muted">
          {t('admin.payments.cards.emergencyHint')}
        </span>
      </div>
      <ConfirmCodeStep
        key={code.binding}
        requestCode={() => requestConfirmation(confirmation)}
        onChange={code.setOtp}
        problem={code.problem}
        onCodeRequested={code.clearProblem}
      />
    </ReasonDialog>
  );
}
