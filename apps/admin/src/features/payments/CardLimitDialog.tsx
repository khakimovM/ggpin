import type { AdminCard } from '@repo/shared';
import { Gauge } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { requestConfirmation } from '../../lib/api/confirmations';
import { changeCard } from '../../lib/api/writes-payments';
import { pendingFields } from '../../lib/idempotency';
import { AmountField } from '../common/AmountField';
import { CheckField } from '../common/CheckField';
import { ConfirmCodeStep } from '../common/ConfirmCodeStep';
import { ReasonDialog } from '../common/ReasonDialog';
import { useAdminAction } from '../common/use-admin-action';
import { useCodeStep } from '../common/use-code-step';
import { cancelledDetail, cardLabel, tiyinAsInput } from './card-text';
import { limitBody, limitConfirmation, limitInput, lowersLimit } from './card-limit-model';
import { CREDIT_RULES } from './review-credit-model';
import { NotSentError } from '../../lib/api/errors';

interface Props {
  card: AdminCard;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CardLimitDialog(props: Props) {
  return props.open ? <CardLimitOpen {...props} /> : null;
}

const str = (value: string | boolean | undefined, fallback: string) =>
  typeof value === 'string' ? value : fallback;

/**
 * card:limit (OWNER): the receive limit and the monthly cap (or none). Lowering either one needs
 * the code (owner decision 2026-11-18); raising or removing the monthly cap does not.
 */
function CardLimitOpen({ card, onOpenChange }: Props) {
  const t = useTranslations();
  const act = useAdminAction();
  const action = act.idOf('cards.limit', card.id);
  const [sent] = useState(() => pendingFields(action));
  const [receive, setReceive] = useState(str(sent?.receive, tiyinAsInput(card.receiveLimitTiyin)));
  const [monthly, setMonthly] = useState(
    str(sent?.monthly, card.monthlyLimitTiyin ? tiyinAsInput(card.monthlyLimitTiyin) : ''),
  );
  const [removeMonthly, setRemoveMonthly] = useState(sent?.removeMonthly === true);
  const input = limitInput(card, { receive, monthly, removeMonthly });
  const needsCode = input !== null && lowersLimit(card, input);
  const confirmation = input !== null && needsCode ? limitConfirmation(input) : null;
  const code = useCodeStep(confirmation);
  const name = cardLabel(card);
  return (
    <ReasonDialog
      action={action}
      open
      onOpenChange={onOpenChange}
      title={t('admin.payments.cards.dialog.limit.title')}
      description={t('admin.payments.cards.dialog.limit.body', { card: name })}
      icon={Gauge}
      submitLabel={t('admin.payments.cards.dialog.limit.cta')}
      actor={act.actor}
      extraValid={input !== null && (!needsCode || code.otp !== null)}
      fields={{ receive, monthly, removeMonthly }}
      onOutcomeFound={(applied) => act.found('cards.limit', applied)}
      onRestart={code.reset}
      onSubmit={async ({ reason, idempotencyKey }) => {
        if (input === null) throw new NotSentError();
        try {
          const result = await changeCard(
            card.id,
            {
              action: 'cards.limit',
              body: limitBody(input, { reason, otp: needsCode ? code.otp : null }),
            },
            idempotencyKey,
          );
          act.finished('cards.limit', result, cancelledDetail(t, result.cancelledIntents));
        } catch (error) {
          code.refused(error);
          throw error;
        }
      }}
    >
      <AmountField
        label={t('admin.payments.cards.receiveLimit')}
        value={receive}
        onChange={setReceive}
        autoFocus
        {...CREDIT_RULES}
      />
      {removeMonthly ? null : (
        <AmountField
          label={t('admin.payments.cards.monthlyLimit')}
          value={monthly}
          onChange={setMonthly}
          {...CREDIT_RULES}
        />
      )}
      <CheckField
        label={t('admin.payments.cards.removeMonthly')}
        checked={removeMonthly}
        onChange={setRemoveMonthly}
      />
      {needsCode ? (
        <>
          <p className="m-0 text-[11px] leading-[15px] font-semibold text-foreground-muted">
            {t('admin.payments.cards.lowersNeedsCode')}
          </p>
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
