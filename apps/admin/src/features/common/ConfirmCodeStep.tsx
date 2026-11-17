import type { AdminConfirmationResponse, AdminOtpAnswer } from '@repo/shared';
import { OTP_LENGTH } from '@repo/shared';
import { Button, Icon, OtpInput } from '@repo/ui';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import {
  adminFieldCode,
  attemptsLeftOf,
  isApiError,
  type ApiErrorMessageKey,
} from '../../lib/api/errors';
import { formatCountdown } from '../../lib/format';
import { useCountdown } from '../../lib/use-countdown';

/** Why the last attempt with the code failed; the action's error decides, the step only shows it. */
export type ConfirmCodeProblem =
  | { kind: 'wrong'; attemptsLeft: number }
  | { kind: 'locked' }
  | { kind: 'expired' }
  | { kind: 'required' };

export interface ConfirmCodeStepProps {
  /** Calls `POST /admin/confirmations` with the action's exact body (the code is bound to it). */
  requestCode: () => Promise<AdminConfirmationResponse>;
  /** The answer to put in the action body, or null while incomplete or expired. */
  onChange: (answer: AdminOtpAnswer | null) => void;
  /** The action's last refusal that concerns the code (see `confirmProblemOf`). */
  problem?: ConfirmCodeProblem | null;
  disabled?: boolean;
}

/** Reads the code-related refusal out of an action's API error (docs/04 admin errors table). */
export function confirmProblemOf(error: unknown): ConfirmCodeProblem | null {
  const attemptsLeft = attemptsLeftOf(error);
  if (attemptsLeft !== undefined) return { kind: 'wrong', attemptsLeft };
  if (isApiError(error) && error.code === 'CODE_EXPIRED') return { kind: 'expired' };
  const field = adminFieldCode(error, 'otp');
  if (field === 'OTP_LOCKED') return { kind: 'locked' };
  if (field === 'OTP_REQUIRED') return { kind: 'required' };
  return null;
}

type Challenge = { id: string; deadline: number };

/**
 * The Telegram code box of a step-up action (Admin.dc.html dialogs, D-63 (4)): "Kodni olish"
 * sends the code to the admin's own Telegram, then six boxes and a 3-minute timer. A new code is
 * a new challenge; the old answer is dropped at once.
 */
export function ConfirmCodeStep({
  requestCode,
  onChange,
  problem,
  disabled,
}: ConfirmCodeStepProps) {
  const t = useTranslations();
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [code, setCode] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const left = useCountdown(challenge?.deadline ?? null);
  const expired = challenge !== null && left === 0;
  const stale = problem?.kind === 'locked' || problem?.kind === 'expired';

  const request = async () => {
    setRequesting(true);
    setRequestError(null);
    setCode('');
    onChange(null);
    try {
      const result = await requestCode();
      setChallenge({ id: result.challengeId, deadline: Date.now() + result.expiresInSec * 1000 });
    } catch (error) {
      setRequestError(t(requestErrorKey(error)));
    } finally {
      setRequesting(false);
    }
  };

  const edit = (value: string) => {
    setCode(value);
    onChange(
      challenge !== null && !expired && value.length === OTP_LENGTH
        ? { challengeId: challenge.id, code: value }
        : null,
    );
  };

  const message = expired
    ? t('admin.confirm.expired')
    : problem?.kind === 'wrong'
      ? t('admin.confirm.wrong', { count: problem.attemptsLeft })
      : problem?.kind === 'locked'
        ? t('admin.confirm.locked')
        : problem?.kind === 'expired'
          ? t('admin.confirm.expired')
          : problem?.kind === 'required'
            ? t('admin.confirm.required')
            : null;

  return (
    <fieldset className="m-0 flex flex-col gap-2.5 rounded-sm border-0 bg-warning-soft p-3">
      <legend className="sr-only">{t('admin.confirm.title')}</legend>
      <div className="flex items-start gap-2 text-warning-text">
        <Icon icon={ShieldCheck} size={16} className="mt-px flex-none" />
        <div className="flex flex-col gap-0.5">
          <span className="text-xs leading-4 font-extrabold" aria-hidden="true">
            {t('admin.confirm.title')}
          </span>
          <span className="text-[11px] leading-[15px] font-semibold">
            {t('admin.confirm.hint')}
          </span>
        </div>
      </div>
      {challenge === null || stale || expired ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={requesting}
          disabled={disabled}
          onClick={() => void request()}
          className="self-start"
        >
          {challenge === null ? t('admin.confirm.request') : t('admin.confirm.newCode')}
        </Button>
      ) : null}
      {challenge !== null && !expired && !stale ? (
        <div className="flex flex-col gap-1.5">
          <OtpInput
            value={code}
            onChange={edit}
            length={OTP_LENGTH}
            label={t('admin.confirm.label')}
            boxLabel={(position) => t('admin.login.codeBox', { position })}
            error={problem?.kind === 'wrong'}
            errorKey={problem?.kind === 'wrong' ? problem.attemptsLeft : 0}
            disabled={disabled}
            autoFocus
          />
          <span className="text-[11px] leading-[15px] font-bold text-foreground-secondary tabular-nums">
            {t('admin.confirm.timer', { time: formatCountdown(left) })}
          </span>
        </div>
      ) : null}
      {message !== null || requestError !== null ? (
        <p role="alert" className="m-0 text-xs leading-4 font-bold text-danger-text">
          {requestError ?? message}
        </p>
      ) : null}
    </fieldset>
  );
}

function requestErrorKey(
  error: unknown,
):
  | 'admin.confirm.unavailable'
  | 'admin.confirm.rateLimited'
  | 'admin.dialogs.failed'
  | ApiErrorMessageKey {
  if (adminFieldCode(error, 'otp') === 'OTP_UNAVAILABLE') return 'admin.confirm.unavailable';
  if (isApiError(error) && error.code === 'RATE_LIMITED') return 'admin.confirm.rateLimited';
  return isApiError(error) ? error.messageKey : 'admin.dialogs.failed';
}
