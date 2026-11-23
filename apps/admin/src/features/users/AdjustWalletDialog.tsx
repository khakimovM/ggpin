import type { AdminUserDetailResponse } from '@repo/shared';
import { SegmentedControl } from '@repo/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Scale } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { requestConfirmation } from '../../lib/api/confirmations';
import { adjustWallet, getAdjustPreview } from '../../lib/api/writes-users';
import { formatTiyin } from '../../lib/format';
import { actionIdempotencyKey, pendingAction, pendingFields } from '../../lib/idempotency';
import { qk } from '../../lib/query-keys';
import { useDebounced } from '../../lib/use-debounced';
import { actionErrorKey, actionFieldCode } from '../common/action-error-text';
import { AmountField } from '../common/AmountField';
import { ConfirmCodeStep } from '../common/ConfirmCodeStep';
import { ReasonDialog } from '../common/ReasonDialog';
import { useAdminAction } from '../common/use-admin-action';
import { useCodeStep } from '../common/use-code-step';
import { AdjustPreviewPanel } from './AdjustPreviewPanel';
import {
  ADJUST_RULES,
  adjustBody,
  adjustConfirmation,
  setsConfirmed,
  signedAmount,
  tickedFor,
  type AdjustSign,
} from './adjust-model';
import { NotSentError } from '../../lib/api/errors';

interface Props {
  user: AdminUserDetailResponse;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Mounted only while open, so every opening starts from the registry (or empty). */
export function AdjustWalletDialog(props: Props) {
  return props.open ? <AdjustWalletOpen {...props} /> : null;
}

function text(value: string | boolean | undefined): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Wallet adjustment (OWNER, AdminOps.dc.html `balance`): sign pills, the amount, the preview from
 * the API (new balance, recent automatic top-ups, open orders to tick), the re-typed amount and
 * the code when the API says one is needed. The code is requested with the same builder that
 * makes the action body, bound to this action's Idempotency-Key (one code, one movement).
 */
function AdjustWalletOpen({ user, name, onOpenChange }: Props) {
  const t = useTranslations();
  const act = useAdminAction();
  const action = act.idOf('users.adjustWallet', user.id);
  const [sent] = useState(() => pendingFields(action));
  const [sign, setSign] = useState<AdjustSign>(sent?.sign === '-' ? '-' : '+');
  const [amount, setAmount] = useState(text(sent?.amount));
  const [retype, setRetype] = useState(text(sent?.retype));
  // Each tick holds the set id it was given for (CR-2): a preview with another set id (new
  // top-ups or orders) shows the box unticked again, so a tick never covers what was not seen.
  const [recentFor, setRecentFor] = useState<string | null>(text(sent?.recent) || null);
  const [openOrdersFor, setOpenOrdersFor] = useState<string | null>(text(sent?.openOrders) || null);
  // Read once, not on every render (CR-4); "start as a new action" puts the new key here.
  const [key, setKey] = useState(() => actionIdempotencyKey(action));
  // R-9: the registry is the truth; if its key moved on (another tab path, a restart), bind the
  // code to that key (the code step resets with the binding) instead of a stale one.
  const liveKey = pendingAction(action)?.key;
  if (liveKey !== undefined && liveKey !== key) setKey(liveKey);
  const signed = signedAmount(sign, amount);
  const settled = useDebounced(signed, 300);
  const preview = useQuery({
    queryKey: qk.users.adjustPreview(user.id, settled ?? '0'),
    queryFn: ({ signal }) => getAdjustPreview(user.id, settled ?? '0', signal),
    enabled: settled !== null,
    placeholderData: keepPreviousData,
    staleTime: 0,
  });
  const current = settled !== null && settled === signed && !preview.isPlaceholderData;
  const data = current ? preview.data : undefined;
  const recentConfirmed = tickedFor(recentFor, data?.confirmOverrideSet);
  const openOrdersConfirmed = tickedFor(openOrdersFor, data?.confirmOpenOrdersSet);
  const needsCode = data?.otpRequired ?? false;
  const retyped = signedAmount(sign, retype);
  const mismatch = needsCode && retype !== '' && retyped !== signed;
  const base =
    data !== undefined && signed !== null
      ? {
          userId: user.id,
          amountTiyin: signed,
          preview: data,
          recentConfirmed,
          openOrdersConfirmed,
          idempotencyKey: key,
          confirmAmountTiyin: needsCode ? retyped : null,
        }
      : null;
  const confirmation =
    base !== null && needsCode && retyped !== null && !mismatch && setsConfirmed(base)
      ? adjustConfirmation(base)
      : null;
  const code = useCodeStep(confirmation);
  const ready =
    base !== null &&
    setsConfirmed(base) &&
    (!needsCode || (confirmation !== null && code.otp !== null));

  return (
    <ReasonDialog
      action={action}
      open
      onOpenChange={onOpenChange}
      title={t('admin.users.dialog.adjust.title')}
      description={t('admin.users.dialog.adjust.body', {
        name,
        balance: `${formatTiyin(user.balanceTiyin)} ${t('admin.money.som')}`,
      })}
      icon={Scale}
      submitLabel={t('admin.users.dialog.adjust.cta')}
      actor={act.actor}
      extraValid={ready}
      fields={{
        sign,
        amount,
        retype,
        recent: recentFor ?? false,
        openOrders: openOrdersFor ?? false,
      }}
      onOutcomeFound={() => act.found('users.adjustWallet')}
      onRestart={() => {
        code.reset();
        setKey(actionIdempotencyKey(action));
      }}
      onSubmit={async ({ reason, idempotencyKey }) => {
        if (base === null) throw new NotSentError();
        try {
          const result = await adjustWallet(
            user.id,
            adjustBody(base, { reason, otp: needsCode ? code.otp : null }),
            idempotencyKey,
          );
          act.finished('users.adjustWallet', result);
        } catch (error) {
          code.refused(error);
          const field = actionFieldCode(error);
          if (
            field === 'RECENT_AUTO_TOPUP' ||
            field === 'OPEN_ORDERS' ||
            field === 'OTP_REQUIRED'
          ) {
            // The server saw another picture: tick again on the fresh preview.
            setRecentFor(null);
            setOpenOrdersFor(null);
            void preview.refetch();
          }
          throw error;
        }
      }}
    >
      <SegmentedControl
        options={[
          { value: '+', label: t('admin.dialogs.sign.plus') },
          { value: '-', label: t('admin.dialogs.sign.minus') },
        ]}
        value={sign}
        onValueChange={setSign}
        ariaLabel={t('admin.dialogs.sign.label')}
        size="sm"
        className="self-start"
      />
      <AmountField
        label={t('admin.dialogs.amount.label')}
        value={amount}
        onChange={setAmount}
        autoFocus
        {...ADJUST_RULES}
      />
      <AdjustPreviewPanel
        preview={data}
        idle={signed === null}
        error={preview.isError && current ? t(actionErrorKey(preview.error)) : null}
        onRetry={() => void preview.refetch()}
        recentConfirmed={recentConfirmed}
        onRecentConfirmed={(ticked) =>
          setRecentFor(ticked ? (data?.confirmOverrideSet ?? null) : null)
        }
        openOrdersConfirmed={openOrdersConfirmed}
        onOpenOrdersConfirmed={(ticked) =>
          setOpenOrdersFor(ticked ? (data?.confirmOpenOrdersSet ?? null) : null)
        }
      />
      {needsCode ? (
        <>
          <AmountField
            label={t('admin.dialogs.amount.retype')}
            hint={t('admin.dialogs.amount.retypeHint')}
            value={retype}
            onChange={setRetype}
            mismatch={mismatch}
            {...ADJUST_RULES}
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
