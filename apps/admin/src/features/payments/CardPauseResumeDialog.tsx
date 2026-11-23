import type { AdminCard, AdminCardResumeBody, AdminConfirmationBody } from '@repo/shared';
import { Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { requestConfirmation } from '../../lib/api/confirmations';
import { changeCard } from '../../lib/api/writes-payments';
import { pendingFields } from '../../lib/idempotency';
import { actionFieldCode } from '../common/action-error-text';
import { CheckField } from '../common/CheckField';
import { ConfirmCodeStep } from '../common/ConfirmCodeStep';
import { ReasonDialog } from '../common/ReasonDialog';
import { useAdminAction } from '../common/use-admin-action';
import { useCodeStep } from '../common/use-code-step';
import { cancelledDetail, cardLabel } from './card-text';

interface Props {
  kind: 'cards.pause' | 'cards.resume';
  card: AdminCard;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CardPauseResumeDialog(props: Props) {
  return props.open ? <PauseResumeOpen {...props} /> : null;
}

/** The resume body and its code binding from the same flags (docs/04 «cards/:id/resume»). */
export function resumeConfirmation(
  cardId: string,
  flags: { confirmOverride: boolean; confirmSecurityPause: boolean },
): AdminConfirmationBody {
  return { action: 'cards.resume', targetId: cardId, ...flags };
}

/**
 * card:pause / card:resume (OWNER). A pause needs only a reason. A resume says what stands in the
 * way only when the API refuses: open pause reviews → "resume anyway"; a SECURITY pause → its
 * checkbox and the acting OWNER's code (D-65 D3). The panel cannot know either beforehand.
 */
function PauseResumeOpen({ kind, card, onOpenChange }: Props) {
  const t = useTranslations();
  const act = useAdminAction();
  const action = act.idOf(kind, card.id);
  const [sent] = useState(() => pendingFields(action));
  const [askOverride, setAskOverride] = useState(sent?.askOverride === true);
  const [askSecurity, setAskSecurity] = useState(sent?.askSecurity === true);
  const [confirmOverride, setConfirmOverride] = useState(sent?.override === true);
  const [confirmSecurityPause, setConfirmSecurityPause] = useState(sent?.security === true);
  const flags = { confirmOverride, confirmSecurityPause };
  const confirmation =
    kind === 'cards.resume' && confirmSecurityPause ? resumeConfirmation(card.id, flags) : null;
  const code = useCodeStep(confirmation);
  const look = kind === 'cards.pause' ? 'pause' : 'resume';
  const ready =
    (!askOverride || confirmOverride) &&
    (!askSecurity || (confirmSecurityPause && code.otp !== null));

  const resumeBody = (reason: string): AdminCardResumeBody => ({
    reason,
    ...flags,
    ...(confirmSecurityPause && code.otp !== null ? { otp: code.otp } : {}),
  });

  return (
    <ReasonDialog
      action={action}
      open
      onOpenChange={onOpenChange}
      title={t(`admin.payments.cards.dialog.${look}.title`)}
      description={t(`admin.payments.cards.dialog.${look}.body`, { card: cardLabel(card) })}
      icon={kind === 'cards.pause' ? Pause : Play}
      submitLabel={t(`admin.payments.cards.dialog.${look}.cta`)}
      actor={act.actor}
      extraValid={ready}
      fields={{
        askOverride,
        askSecurity,
        override: confirmOverride,
        security: confirmSecurityPause,
      }}
      onOutcomeFound={() => act.found(kind)}
      onRestart={code.reset}
      onSubmit={async ({ reason, idempotencyKey }) => {
        try {
          const result = await changeCard(
            card.id,
            kind === 'cards.pause'
              ? { action: 'cards.pause', body: { reason } }
              : { action: 'cards.resume', body: resumeBody(reason) },
            idempotencyKey,
          );
          act.finished(kind, result, cancelledDetail(t, result.cancelledIntents));
        } catch (error) {
          const field = actionFieldCode(error);
          if (field === 'OPEN_PAUSE_REVIEWS') setAskOverride(true);
          else if (field === 'SECURITY_PAUSE_OPEN') setAskSecurity(true);
          else code.refused(error);
          throw error;
        }
      }}
    >
      {askOverride ? (
        <CheckField
          label={t('admin.payments.cards.confirmOverride')}
          checked={confirmOverride}
          onChange={setConfirmOverride}
          tone="warning"
        />
      ) : null}
      {askSecurity ? (
        <CheckField
          label={t('admin.payments.cards.confirmSecurityPause')}
          checked={confirmSecurityPause}
          onChange={setConfirmSecurityPause}
          tone="warning"
        />
      ) : null}
      {confirmation === null ? null : (
        <ConfirmCodeStep
          key={code.binding}
          requestCode={() => requestConfirmation(confirmation)}
          onChange={code.setOtp}
          problem={code.problem}
          onCodeRequested={code.clearProblem}
        />
      )}
    </ReasonDialog>
  );
}
