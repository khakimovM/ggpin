import type { AdminReviewDetailResponse } from '@repo/shared';
import { Input, SegmentedControl } from '@repo/ui';
import { useQuery } from '@tanstack/react-query';
import { BadgeCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { requestConfirmation } from '../../lib/api/confirmations';
import { creditReview, getCreditPreview } from '../../lib/api/writes-payments';
import { formatTiyin } from '../../lib/format';
import { pendingFields } from '../../lib/idempotency';
import { qk } from '../../lib/query-keys';
import { useDebounced } from '../../lib/use-debounced';
import { actionErrorKey } from '../common/action-error-text';
import { AmountField } from '../common/AmountField';
import { CheckField } from '../common/CheckField';
import { ConfirmCodeStep } from '../common/ConfirmCodeStep';
import { ReasonDialog } from '../common/ReasonDialog';
import { useAdminAction } from '../common/use-admin-action';
import { useCodeStep } from '../common/use-code-step';
import { CreditPreviewPanel } from './CreditPreviewPanel';
import {
  CREDIT_RULES,
  creditBody,
  creditConfirmation,
  creditTarget,
  flagsTransition,
  initialFlagsSeen,
  previewAsks,
  retypedCredit,
  targetKeyOf,
  type FlagsSeen,
  type CreditTargetKind,
} from './review-credit-model';
import { NotSentError } from '../../lib/api/errors';

interface Props {
  review: AdminReviewDetailResponse;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ReviewCreditDialog(props: Props) {
  return props.open ? <ReviewCreditOpen {...props} /> : null;
}

const str = (value: string | boolean | undefined) => (typeof value === 'string' ? value : '');

/**
 * review:credit in the panel (OWNER, D-66): to the review's request or to a user by id, the
 * preview the CLI prints, the override and bank-verified flags when the preview asks for them,
 * the re-typed amount and always the code (D-63 (4)).
 */
function ReviewCreditOpen({ review, onOpenChange }: Props) {
  const t = useTranslations();
  const act = useAdminAction();
  const action = act.idOf('payments.reviewCredit', review.id);
  const [sent] = useState(() => pendingFields(action));
  const [kind, setKind] = useState<CreditTargetKind>(
    sent?.target === 'user' || review.intentId === null ? 'user' : 'intent',
  );
  const [intentId, setIntentId] = useState(str(sent?.intentId) || (review.intentId ?? ''));
  const [userId, setUserId] = useState(str(sent?.userId));
  const [override, setOverride] = useState(sent?.override === true);
  const [bankVerified, setBankVerified] = useState(sent?.bankVerified === true);
  const [retype, setRetype] = useState(str(sent?.retype));
  const target = creditTarget(kind, { intentId, userId });
  const settled = useDebounced(target, 300);
  const settledKey = settled === null ? '' : Object.values(settled).join('');
  const preview = useQuery({
    queryKey: qk.payments.creditPreview(review.id, `${kind}:${settledKey}`),
    queryFn: ({ signal }) => getCreditPreview(review.id, settled ?? { userId: '' }, signal),
    enabled: settled !== null,
    staleTime: 0,
  });
  const current =
    target !== null && settled !== null && Object.values(target).join('') === settledKey;
  const data = current ? preview.data : undefined;
  const confirmAmount = retypedCredit(retype);
  const mismatch =
    data !== undefined && confirmAmount !== null && confirmAmount !== data.amountTiyin;
  const needsOverride = data !== undefined && data.overrideNeeded !== null;
  const needsBank = data?.needsBankVerification ?? false;
  // The override and bank-verified ticks were given for ONE target and ONE preview (CR-1, R-5):
  // another request or user, or a preview asking for something else, clears them.
  const [flagsSeen, setFlagsSeen] = useState<FlagsSeen>(() =>
    initialFlagsSeen(targetKeyOf(kind, target), sent),
  );
  const flagsStep = flagsTransition(flagsSeen, targetKeyOf(kind, target), previewAsks(data));
  if (flagsStep !== null) {
    setFlagsSeen(flagsStep.seen);
    if (flagsStep.reset) {
      setOverride(false);
      setBankVerified(false);
    }
  }
  const input =
    target !== null && data !== undefined && confirmAmount !== null && !mismatch
      ? {
          reviewId: review.id,
          target,
          confirmOverride: needsOverride && override,
          bankVerified: needsBank && bankVerified,
          confirmAmountTiyin: confirmAmount,
        }
      : null;
  const flagsOk = (!needsOverride || override) && (!needsBank || bankVerified);
  const confirmation = input !== null && flagsOk ? creditConfirmation(input) : null;
  const code = useCodeStep(confirmation);
  const amountText = review.amountTiyin
    ? `${formatTiyin(review.amountTiyin)} ${t('admin.money.som')}`
    : '—';

  return (
    <ReasonDialog
      action={action}
      open
      onOpenChange={onOpenChange}
      title={t('admin.payments.review.creditTitle')}
      description={t('admin.payments.review.creditBody', { amount: amountText })}
      icon={BadgeCheck}
      submitLabel={t('admin.payments.review.credit')}
      actor={act.actor}
      extraValid={confirmation !== null && code.otp !== null}
      fields={{
        target: kind,
        intentId,
        userId,
        override,
        bankVerified,
        retype,
        asks: previewAsks(data) ?? '',
      }}
      onOutcomeFound={() => act.found('payments.reviewCredit')}
      onRestart={code.reset}
      onSubmit={async ({ reason, idempotencyKey }) => {
        if (input === null || code.otp === null) throw new NotSentError();
        try {
          const result = await creditReview(
            review.id,
            creditBody(input, { reason, otp: code.otp }),
            idempotencyKey,
          );
          act.finished('payments.reviewCredit', result);
        } catch (error) {
          code.refused(error);
          throw error;
        }
      }}
    >
      <SegmentedControl
        options={[
          { value: 'intent', label: t('admin.payments.review.targetIntent') },
          { value: 'user', label: t('admin.payments.review.targetUser') },
        ]}
        value={kind}
        onValueChange={setKind}
        ariaLabel={t('admin.payments.review.target')}
        size="sm"
        className="self-start"
      />
      {kind === 'intent' ? (
        <Input
          label={t('admin.payments.review.intentIdLabel')}
          value={intentId}
          onValueChange={setIntentId}
          autoComplete="off"
          spellCheck={false}
        />
      ) : (
        <Input
          label={t('admin.payments.review.userIdLabel')}
          value={userId}
          onValueChange={setUserId}
          autoComplete="off"
          spellCheck={false}
        />
      )}
      <CreditPreviewPanel
        preview={data}
        idle={target === null}
        error={preview.isError && current ? t(actionErrorKey(preview.error)) : null}
        onRetry={() => void preview.refetch()}
      />
      {needsOverride ? (
        <CheckField
          label={t('admin.payments.review.confirmOverride')}
          checked={override}
          onChange={setOverride}
          tone="warning"
        />
      ) : null}
      {needsBank ? (
        <CheckField
          label={t('admin.payments.review.bankVerified')}
          checked={bankVerified}
          onChange={setBankVerified}
          tone="warning"
        />
      ) : null}
      <AmountField
        label={t('admin.dialogs.amount.retype')}
        hint={t('admin.dialogs.amount.retypeHint')}
        value={retype}
        onChange={setRetype}
        mismatch={mismatch}
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
    </ReasonDialog>
  );
}
