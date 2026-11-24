import {
  ADMIN_NOTE_MAX_LENGTH,
  ADMIN_REASON_MAX_LENGTH,
  ADMIN_REASON_MIN_LENGTH,
  AdminNoteTextSchema,
  AdminReasonSchema,
} from '@repo/shared';
import { Button, Icon, cn } from '@repo/ui';
import { CircleAlert, CircleCheck, CircleHelp, ScrollText } from 'lucide-react';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { isActionOutcomeUnknown, isIdempotencyConflict } from '../../lib/api/errors';
import {
  beginAttempt,
  pendingAttemptMark,
  endRefusedAttempt,
  markActionOutcomeUnknown,
  pendingAction,
  pendingInFlight,
  registryVersion,
  settleActionIdempotencyKey,
  subscribeRegistry,
  type AdminActionId,
} from '../../lib/idempotency';
import { blockingOpposite, type OppositeTitleKey } from '../../lib/opposite-actions';
import { actionErrorKey } from './action-error-text';
import { NOTICE_BOX } from './notice-box';
import { OppositeNotice } from './OppositeNotice';
import { OutcomeCheck } from './OutcomeCheck';
import type { ReasonDialogProps } from './ReasonDialog';

type TextIssue = 'tooShort' | 'tooLong' | 'invalid';
type Notice = 'unknownOutcome' | 'idempotencyConflict';

function noticeOf(action: AdminActionId): Notice | null {
  const pending = pendingAction(action);
  if (!pending?.unknown) return null;
  return pending.conflict ? 'idempotencyConflict' : 'unknownOutcome';
}

function textIssue(value: string, field: 'reason' | 'note'): TextIssue | null {
  const schema = field === 'note' ? AdminNoteTextSchema : AdminReasonSchema;
  if (schema.safeParse(value).success) return null;
  const length = value.trim().length;
  const min = field === 'note' ? 1 : ADMIN_REASON_MIN_LENGTH;
  const max = field === 'note' ? ADMIN_NOTE_MAX_LENGTH : ADMIN_REASON_MAX_LENGTH;
  if (length < min) return 'tooShort';
  if (length > max) return 'tooLong';
  return 'invalid';
}

/** The body of <ReasonDialog>: the text field, the parent's fields, notices and the buttons. */
export function ReasonForm({
  action,
  onOpenChange,
  tone = 'primary',
  submitLabel,
  placeholder,
  actor,
  children,
  extraValid = true,
  fields,
  textField = 'reason',
  voidTargetId,
  onOutcomeFound,
  onRestart,
  onSubmit,
  icon,
  busy,
  setBusy,
}: ReasonDialogProps & { busy: boolean; setBusy: (busy: boolean) => void }) {
  const t = useTranslations();
  const fieldId = useId();
  // Synchronous: two submits in one tick both see `busy === false` in state, never in a ref.
  const sending = useRef(false);
  // R3-1: a notice that a submit of THIS dialog just caused is announced and takes the focus the
  // disabled submit lost; one already there when the dialog opens stays a quiet status.
  const [noticeAlert, setNoticeAlert] = useState(false);
  const focusResolve = useRef(false);
  const noticeBox = useRef<HTMLDivElement>(null);
  const [text, setText] = useState(() => pendingAction(action)?.reason ?? '');
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The void said VOIDED: say that the old request is dead and a new key is ready.
  const [voided, setVoided] = useState(false);
  // The opposite action's void said VOIDED (N-3): which one, for its own text.
  const [oppositeVoided, setOppositeVoided] = useState<OppositeTitleKey | null>(null);
  // CR-S9b-1: the registry decides; an answer arriving after this dialog closed counts too.
  useSyncExternalStore(subscribeRegistry, registryVersion);
  const notice = noticeOf(action);
  // While the outcome is unknown only the void may go on (9B-3): a resend could silently replay
  // the old key's action, e.g. a deactivation over a reactivation made since. While an attempt is
  // out (the dialog was closed and reopened meanwhile) a second one would only race it (CR-2). An
  // unknown or still-out opposite action on the same target locks this one too (SA L-2, L-4).
  const opposite = blockingOpposite(action);
  const locked =
    pendingAction(action)?.unknown === true || pendingInFlight(action) || opposite !== null;
  // Once the submit settled (the button is no longer busy), the focus goes to «Natijani aniqlash».
  useEffect(() => {
    if (!focusResolve.current || busy || notice === null) return;
    focusResolve.current = false;
    noticeBox.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [busy, notice]);
  const issue = textField === 'none' ? null : textIssue(text, textField);
  const showIssue = touched && issue !== null;
  const max = textField === 'note' ? ADMIN_NOTE_MAX_LENGTH : ADMIN_REASON_MAX_LENGTH;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (issue !== null || !extraValid || sending.current) return;
    if (pendingAction(action)?.unknown === true || pendingInFlight(action)) return;
    if (blockingOpposite(action) !== null) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    setNoticeAlert(false);
    setVoided(false);
    setOppositeVoided(null);
    const { key, attempt } = beginAttempt(action, voidTargetId);
    const sent = { reason: text.trim(), idempotencyKey: key };
    try {
      await onSubmit(sent);
      settleActionIdempotencyKey(action, key);
      onOpenChange(false);
    } catch (error) {
      // Only a 2xx ends the key. A refusal (4xx, 404, 429, the API's deadline 503) keeps it and
      // its flags, an unknown outcome (CODE_EXPIRED after a submit included, SA-S6-7) marks it;
      // this runs even if the dialog unmounted meanwhile.
      if (isActionOutcomeUnknown(error)) {
        markActionOutcomeUnknown(action, key, {
          reason: sent.reason,
          conflict: isIdempotencyConflict(error),
          ...(fields === undefined ? {} : { fields }),
          attempt,
          ...(voidTargetId === undefined ? {} : { voidTargetId }),
        });
      } else {
        endRefusedAttempt(action, key, attempt);
      }
      // A 409 conflict is told once, by its notice with the void (not by a second alert).
      // A 409 conflict is told once, by its notice (an alert then) with the void; other unknown
      // outcomes keep their error alert, the notice stays a status beside it.
      setFailure(isIdempotencyConflict(error) ? null : t(actionErrorKey(error)));
      setNoticeAlert(isIdempotencyConflict(error));
      focusResolve.current = isActionOutcomeUnknown(error);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const field = textField === 'none' ? null : textField;
  const hint =
    field === null
      ? null
      : showIssue
        ? t(`admin.dialogs.${field}.${issue ?? 'invalid'}`, { min: ADMIN_REASON_MIN_LENGTH, max })
        : t(`admin.dialogs.${field}.hint`, { min: ADMIN_REASON_MIN_LENGTH, max });

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-3.5">
      {field === null ? null : (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={fieldId} className="text-xs leading-4 font-extrabold">
            {t(`admin.dialogs.${field}.label`)}{' '}
            <span className="text-danger-text" aria-hidden="true">
              *
            </span>
            <span className="sr-only">({t('admin.dialogs.reason.required')})</span>
          </label>
          <textarea
            id={fieldId}
            value={text}
            rows={3}
            maxLength={max + 50}
            placeholder={placeholder}
            aria-invalid={showIssue}
            aria-describedby={`${fieldId}-hint`}
            onChange={(event) => setText(event.target.value)}
            onBlur={() => setTouched(true)}
            className={cn(
              'min-h-[72px] resize-y rounded-sm border-[1.5px] bg-input px-3 py-2.5 text-[13px] leading-[19px] font-semibold text-foreground',
              'focus:border-ring focus:ring-[3px] focus:ring-primary-soft focus:outline-none',
              showIssue ? 'border-danger' : 'border-input-border',
            )}
          />
          <span
            id={`${fieldId}-hint`}
            className={cn(
              'text-[11px] leading-[15px] font-semibold',
              showIssue ? 'text-danger-text' : 'text-foreground-muted',
            )}
          >
            {hint}
          </span>
        </div>
      )}
      {children}
      {notice !== null ? (
        <div
          ref={noticeBox}
          role={noticeAlert && notice === 'idempotencyConflict' ? 'alert' : 'status'}
          className={cn(NOTICE_BOX, 'flex-col bg-warning-soft text-warning-text')}
        >
          <span className="flex items-start gap-2">
            <Icon icon={CircleHelp} size={16} className="mt-px flex-none" />
            {t(`admin.dialogs.${notice}`)}
          </span>
          {/* Keyed by the attempt (R-1): a new attempt starts a fresh check, never an old verdict. */}
          <OutcomeCheck
            key={pendingAttemptMark(action) ?? 'none'}
            action={action}
            busy={busy}
            onApplied={(applied) => {
              onOutcomeFound?.(applied);
              onOpenChange(false);
            }}
            onVoided={() => {
              setFailure(null);
              setVoided(true);
              onRestart?.();
            }}
          />
        </div>
      ) : null}
      {opposite !== null && notice === null ? (
        <OppositeNotice
          opposite={opposite}
          busy={busy}
          // N-2: the opposite ran; this dialog stays, the data is refreshed and the admin decides
          // (the server refuses an action the new state does not allow).
          onApplied={(applied) => onOutcomeFound?.(applied)}
          onVoided={() => setOppositeVoided(opposite.side.titleKey)}
        />
      ) : null}
      {oppositeVoided !== null && opposite === null && notice === null ? (
        <div role="status" className={cn(NOTICE_BOX, 'bg-success-soft text-success-text')}>
          <Icon icon={CircleCheck} size={16} className="mt-px flex-none" />
          {t('admin.dialogs.oppositeVoided', { action: t(oppositeVoided) })}
        </div>
      ) : null}
      {voided && notice === null && opposite === null ? (
        <div role="status" className={cn(NOTICE_BOX, 'bg-success-soft text-success-text')}>
          <Icon icon={CircleCheck} size={16} className="mt-px flex-none" />
          {t('admin.dialogs.outcome.voided')}
        </div>
      ) : null}
      {failure === null ? null : (
        <div role="alert" className={cn(NOTICE_BOX, 'bg-danger-soft text-danger-text')}>
          <Icon icon={CircleAlert} size={16} className="mt-px flex-none" />
          {failure}
        </div>
      )}
      {/* CR-5: a tall dialog scrolls (the Dialog box is the scroll container), the audit line and
          the buttons stay pinned to its bottom edge, so "send" is never below the fold. */}
      <div className="sticky bottom-0 -mx-5 -mb-5 flex flex-col gap-3 border-t border-border bg-elevated px-5 pt-3 pb-5">
        <p className="m-0 flex items-center gap-1.5 text-[11px] leading-[15px] font-bold text-foreground-muted">
          <Icon icon={ScrollText} size={13} />
          {t('admin.dialogs.audit', { name: actor.name, role: t(`admin.role.${actor.role}`) })}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t('admin.dialogs.cancel')}
          </Button>
          <Button
            type="submit"
            variant={tone === 'danger' ? 'danger' : 'primary'}
            size="sm"
            loading={busy}
            disabled={issue !== null || !extraValid || locked}
          >
            {busy ? null : <Icon icon={icon} size={14} />}
            {submitLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}
