import type { AdminPaymentRow, AdminPaymentReverseBody } from '@repo/shared';
import { Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { requestConfirmation } from '../../lib/api/confirmations';
import { reversePayment } from '../../lib/api/writes-payments';
import { formatTiyin } from '../../lib/format';
import { pendingFields } from '../../lib/idempotency';
import { actionFieldCode } from '../common/action-error-text';
import { AmountField } from '../common/AmountField';
import { ConfirmCodeStep } from '../common/ConfirmCodeStep';
import { ReasonDialog } from '../common/ReasonDialog';
import { useAdminAction } from '../common/use-admin-action';
import { useCodeStep } from '../common/use-code-step';
import { CREDIT_RULES, retypedCredit } from './review-credit-model';

interface Props {
  payment: AdminPaymentRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ReversePaymentDialog(props: Props) {
  return props.open ? <ReverseOpen {...props} /> : null;
}

/**
 * payment:reverse in the panel (OWNER): a TOPUP_REVERSAL of a confirmed top-up. The code is asked
 * above the confirm threshold (`me.limits`, UX only) or when the API refuses with OTP_REQUIRED
 * (daily budget used up); then the amount is re-typed and bound to the code.
 */
function ReverseOpen({ payment, onOpenChange }: Props) {
  const t = useTranslations();
  const act = useAdminAction();
  const action = act.idOf('payments.reverse', payment.id);
  const [sent] = useState(() => pendingFields(action));
  const aboveThreshold = BigInt(payment.amountTiyin) > BigInt(act.limits.confirmThresholdTiyin);
  const [askedForCode, setAskedForCode] = useState(sent?.code === true);
  const needsCode = aboveThreshold || askedForCode;
  const [retype, setRetype] = useState(typeof sent?.retype === 'string' ? sent.retype : '');
  const confirmAmount = retypedCredit(retype);
  const mismatch = confirmAmount !== null && confirmAmount !== payment.amountTiyin;
  const confirmation =
    needsCode && confirmAmount !== null && !mismatch
      ? { action: 'payments.reverse' as const, targetId: payment.id, amountTiyin: confirmAmount }
      : null;
  const code = useCodeStep(confirmation);
  const amount = `${formatTiyin(payment.amountTiyin)} ${t('admin.money.som')}`;

  const body = (reason: string): AdminPaymentReverseBody =>
    needsCode && code.otp !== null && confirmAmount !== null
      ? { reason, otp: code.otp, confirmAmountTiyin: confirmAmount }
      : { reason };

  return (
    <ReasonDialog
      action={action}
      open
      onOpenChange={onOpenChange}
      title={t('admin.payments.reverse.title')}
      description={t('admin.payments.reverse.body', { amount })}
      icon={Undo2}
      tone="danger"
      submitLabel={t('admin.payments.reverse.cta')}
      actor={act.actor}
      extraValid={!needsCode || (confirmation !== null && code.otp !== null)}
      fields={{ code: needsCode, retype }}
      onOutcomeFound={(applied) => act.found('payments.reverse', applied)}
      onRestart={code.reset}
      onSubmit={async ({ reason, idempotencyKey }) => {
        try {
          const result = await reversePayment(payment.id, body(reason), idempotencyKey);
          act.finished(
            'payments.reverse',
            result,
            result.frozen ? t('admin.payments.reverse.frozenWarn') : undefined,
          );
        } catch (error) {
          if (actionFieldCode(error) === 'OTP_REQUIRED') setAskedForCode(true);
          else code.refused(error);
          throw error;
        }
      }}
    >
      {needsCode ? (
        <>
          <AmountField
            label={t('admin.dialogs.amount.retype')}
            hint={t('admin.dialogs.amount.retypeHint')}
            value={retype}
            onChange={setRetype}
            mismatch={mismatch}
            autoFocus
            {...CREDIT_RULES}
          />
          {confirmation === null ? null : (
            <ConfirmCodeStep
              key={code.binding}
              requestCode={() => requestConfirmation(confirmation)}
              onChange={code.setOtp}
              problem={code.problem}
              onCodeRequested={code.clearProblem}
            />
          )}
        </>
      ) : null}
    </ReasonDialog>
  );
}
