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
  isDeadlineExceeded,
  type ApiErrorMessageKey,
} from '../../lib/api/errors';
import { formatCountdown } from '../../lib/format';
import { useCountdown } from '../../lib/use-countdown';

/** Why the last attempt with the code failed; the action's error decides, the step only shows it. */
export type ConfirmCodeProblem =
  | { kind: 'wrong'; attemptsLeft: number }
  | { kind: 'locked' }
  | { kind: 'expired' }
  | { kind: 'required' }
  /** 503 ADMIN_DEADLINE_EXCEEDED: the code may be spent; the key stays, a new code is needed. */
  | { kind: 'deadline' };

export interface ConfirmCodeStepProps {
  /** Calls `POST /admin/confirmations` with the action's exact body (the code is bound to it). */
  requestCode: () => Promise<AdminConfirmationResponse>;
  /** The answer to put in the action body, or null while incomplete or expired. */
  onChange: (answer: AdminOtpAnswer | null) => void;
  /**
   * The action's last refusal that concerns the code (see `confirmProblemOf`). Contract: the
   * parent keeps it in state (one object per refusal) and clears it in `onCodeRequested`. The step
   * also ignores, by identity, the refusal that was showing when a new code was requested: a
   * locked or expired refusal belongs to the old challenge and must not hide the new one.
   */
  problem?: ConfirmCodeProblem | null;
  /** A new code was requested: the parent should drop the refusal of the old challenge. */
  onCodeRequested?: () => void;
  disabled?: boolean;
}

/** Reads the code-related refusal out of an action's API error (docs/04 admin errors table). */
export function confirmProblemOf(error: unknown): ConfirmCodeProblem | null {
  const attemptsLeft = attemptsLeftOf(error);
  if (attemptsLeft !== undefined) return { kind: 'wrong', attemptsLeft };
  if (isApiError(error) && error.code === 'CODE_EXPIRED') return { kind: 'expired' };
  if (isDeadlineExceeded(error)) return { kind: 'deadline' };
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
  problem: givenProblem,
  onCodeRequested,
  disabled,
}: ConfirmCodeStepProps) {
  const t = useTranslations();
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [code, setCode] = useState('');
  const [requesting, setRequesting] = useState(false);
  // From "new code" until a new challenge arrives the old one is dead to this step (CR-8): it
  // may be spent (a deadline 503) or expired, and a failed request (429...) must not revive it.
  const [staleChallenge, setStaleChallenge] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [staleProblem, setStaleProblem] = useState<ConfirmCodeProblem | null>(null);
  const problem = givenProblem && givenProblem !== staleProblem ? givenProblem : null;
  const left = useCountdown(challenge?.deadline ?? null);
  const expired = challenge !== null && left === 0;
  const stale =
    problem?.kind === 'locked' || problem?.kind === 'expired' || problem?.kind === 'deadline';

  const request = async () => {
    setRequesting(true);
    setStaleChallenge(true);
    setRequestError(null);
    setStaleProblem(givenProblem ?? null);
    onCodeRequested?.();
    setCode('');
    onChange(null);
    try {
      const result = await requestCode();
      setChallenge({ id: result.challengeId, deadline: Date.now() + result.expiresInSec * 1000 });
      setStaleChallenge(false);
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
            : problem?.kind === 'deadline'
              ? t('admin.confirm.deadline')
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
      {/* Until a new code arrives the old challenge stays hidden: an answer typed into it would go
          out with the old challenge id and come back CODE_EXPIRED (9B-3 e2e, CR-8). */}
      {challenge === null || stale || expired || staleChallenge ? (
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
      {challenge !== null && !expired && !stale && !staleChallenge ? (
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
        // CR-6: after a deadline 503 the form's own alert announces it; this line only says what
        // to do with the code, so it is not a second alert.
        <p
          role={
            requestError === null && !expired && problem?.kind === 'deadline' ? undefined : 'alert'
          }
          className="m-0 text-xs leading-4 font-bold text-danger-text"
        >
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
  | 'admin.confirm.notRequired'
  | 'admin.confirm.rateLimited'
  | 'admin.dialogs.failed'
  | ApiErrorMessageKey {
  if (adminFieldCode(error, 'otp') === 'OTP_UNAVAILABLE') return 'admin.confirm.unavailable';
  // The action needs no code now (SA-M1): send it without one; the server decides again.
  if (adminFieldCode(error, 'action') === 'OTP_NOT_REQUIRED') return 'admin.confirm.notRequired';
  if (isApiError(error) && error.code === 'RATE_LIMITED') return 'admin.confirm.rateLimited';
  return isApiError(error) ? error.messageKey : 'admin.dialogs.failed';
}
