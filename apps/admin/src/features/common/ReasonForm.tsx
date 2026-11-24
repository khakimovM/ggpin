import {
  ADMIN_NOTE_MAX_LENGTH,
  ADMIN_REASON_MAX_LENGTH,
  ADMIN_REASON_MIN_LENGTH,
  AdminNoteTextSchema,
  AdminReasonSchema,
} from '@repo/shared';
import { Button, Icon, cn } from '@repo/ui';
import { CircleAlert, CircleHelp, ScrollText } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { isActionOutcomeUnknown, isIdempotencyConflict } from '../../lib/api/errors';
import {
  beginAttempt,
  pendingAttemptMark,
  endRefusedAttempt,
  markActionOutcomeUnknown,
  pendingAction,
  settleActionIdempotencyKey,
  type AdminActionId,
} from '../../lib/idempotency';
import { actionErrorKey } from './action-error-text';
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

const BOX = 'flex items-start gap-2 rounded-sm px-3 py-2.5 text-[13px] leading-[18px] font-bold';

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
  lookupOutcome,
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
  const [text, setText] = useState(() => pendingAction(action)?.reason ?? '');
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState(() => noticeOf(action));
  const issue = textField === 'none' ? null : textIssue(text, textField);
  const showIssue = touched && issue !== null;
  const max = textField === 'note' ? ADMIN_NOTE_MAX_LENGTH : ADMIN_REASON_MAX_LENGTH;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (issue !== null || !extraValid || sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    const { key, attempt } = beginAttempt(action);
    const sent = { reason: text.trim(), idempotencyKey: key };
    try {
      await onSubmit(sent);
      settleActionIdempotencyKey(action, key);
      onOpenChange(false);
    } catch (error) {
      // Only a 2xx ends the key. A refusal (4xx, 404, 429) keeps it and its flags, an unknown
      // outcome (CODE_EXPIRED after a submit included, SA-S6-7) marks it; this runs even if the
      // dialog unmounted meanwhile.
      if (isActionOutcomeUnknown(error)) {
        markActionOutcomeUnknown(action, key, {
          reason: sent.reason,
          conflict: isIdempotencyConflict(error),
          ...(fields === undefined ? {} : { fields }),
          attempt,
        });
      } else {
        endRefusedAttempt(action, key, attempt);
      }
      setNotice(noticeOf(action));
      setFailure(t(actionErrorKey(error)));
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
        <div role="status" className={cn(BOX, 'flex-col bg-warning-soft text-warning-text')}>
          <span className="flex items-start gap-2">
            <Icon icon={CircleHelp} size={16} className="mt-px flex-none" />
            {t(`admin.dialogs.${notice}`)}
          </span>
          {/* Keyed by the attempt (R-1): a new attempt starts a fresh check, never an old verdict. */}
          <OutcomeCheck
            key={pendingAttemptMark(action) ?? 'none'}
            action={action}
            busy={busy}
            lookupOutcome={lookupOutcome}
            onFound={(key) => {
              settleActionIdempotencyKey(action, key);
              onOutcomeFound?.();
              onOpenChange(false);
            }}
            onRestarted={() => {
              setNotice(null);
              setFailure(null);
              onRestart?.();
            }}
          />
        </div>
      ) : null}
      {failure === null ? null : (
        <div role="alert" className={cn(BOX, 'bg-danger-soft text-danger-text')}>
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
            disabled={issue !== null || !extraValid}
          >
            {busy ? null : <Icon icon={icon} size={14} />}
            {submitLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}
