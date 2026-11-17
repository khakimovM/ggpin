import {
  ADMIN_REASON_MAX_LENGTH,
  ADMIN_REASON_MIN_LENGTH,
  AdminReasonSchema,
  type AdminRole,
} from '@repo/shared';
import { Button, Dialog, Icon, cn } from '@repo/ui';
import type { LucideIcon } from 'lucide-react';
import { CircleAlert, CircleHelp, ScrollText } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { isApiError, isIdempotencyConflict, isOutcomeUnknown } from '../../lib/api/errors';
import {
  beginActionAttempt,
  endRefusedAttempt,
  markActionOutcomeUnknown,
  pendingAction,
  settleActionIdempotencyKey,
  type AdminActionId,
} from '../../lib/idempotency';

export interface ReasonSubmit {
  /** Trimmed, checked with the shared AdminReasonSchema (10-500 visible characters). */
  reason: string;
  /**
   * The action's key from the registry, written to it before the request leaves: the same for
   * every attempt until a 2xx, also across closing and reopening the dialog and a reload.
   */
  idempotencyKey: string;
}

export interface ReasonDialogProps {
  /**
   * `adminActionId(adminId, kind, targetId)`: names the Idempotency-Key in the registry. A step-up code
   * is requested with `actionIdempotencyKey(action)` too (docs/04). After an unknown outcome the
   * reason field is refilled from the registry; the parent refills its own fields (amount...)
   * from `pendingAction(action)`, and never an OTP code.
   */
  action: AdminActionId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  icon: LucideIcon;
  /** danger for destructive actions (refund, cancel, block). */
  tone?: 'primary' | 'danger';
  submitLabel: string;
  placeholder?: string;
  /** Who is acting: shown in the "written to the audit log" line. */
  actor: { name: string; role: AdminRole };
  /** Extra fields under the reason, e.g. <ConfirmCodeStep>. */
  children?: ReactNode;
  /** False while those extra fields are incomplete. */
  extraValid?: boolean;
  /** Rejects with the API error to keep the dialog open and show it; resolves to close it. */
  onSubmit: (input: ReasonSubmit) => Promise<void>;
}

type ReasonIssue = 'tooShort' | 'tooLong' | 'invalid';
type Notice = 'unknownOutcome' | 'idempotencyConflict';

function noticeOf(action: AdminActionId): Notice | null {
  const pending = pendingAction(action);
  if (!pending?.unknown) return null;
  return pending.conflict ? 'idempotencyConflict' : 'unknownOutcome';
}

function reasonIssue(value: string): ReasonIssue | null {
  if (AdminReasonSchema.safeParse(value).success) return null;
  const length = value.trim().length;
  if (length < ADMIN_REASON_MIN_LENGTH) return 'tooShort';
  if (length > ADMIN_REASON_MAX_LENGTH) return 'tooLong';
  return 'invalid';
}

/**
 * Every admin action that changes something asks for a reason first (Admin.dc.html dialogs,
 * docs/04 `reason`). The form lives only while the dialog is open: an opening starts empty,
 * except after an unknown outcome, when the reason that was sent is refilled from the registry
 * (memory only) so the same body can be resent. The Idempotency-Key lives in the registry by
 * `action` until a 2xx, so a retry after a refusal or an unknown outcome sends the same key
 * (lib/idempotency.ts). While a request is out, leaving the page asks first (beforeunload).
 */
export function ReasonDialog(props: ReasonDialogProps) {
  const t = useTranslations();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!busy) return;
    // A reload now would lose the answer; the key itself is already written ahead (SA M-2).
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);
  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (!busy) props.onOpenChange(next);
      }}
      title={props.title}
      description={props.description}
      icon={<Icon icon={props.icon} size={19} />}
      tone={props.tone}
      closeLabel={t('admin.dialogs.close')}
      dismissible={!busy}
    >
      <ReasonForm {...props} busy={busy} setBusy={setBusy} />
    </Dialog>
  );
}

function ReasonForm({
  action,
  onOpenChange,
  tone = 'primary',
  submitLabel,
  placeholder,
  actor,
  children,
  extraValid = true,
  onSubmit,
  icon,
  busy,
  setBusy,
}: ReasonDialogProps & { busy: boolean; setBusy: (busy: boolean) => void }) {
  const t = useTranslations();
  const fieldId = useId();
  const [reason, setReason] = useState(() => pendingAction(action)?.reason ?? '');
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState(() => noticeOf(action));
  const issue = reasonIssue(reason);
  const showIssue = touched && issue !== null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (issue !== null || !extraValid || busy) return;
    setBusy(true);
    setFailure(null);
    const sent = { reason: reason.trim(), idempotencyKey: beginActionAttempt(action) };
    try {
      await onSubmit(sent);
      settleActionIdempotencyKey(action, sent.idempotencyKey);
      setBusy(false);
      onOpenChange(false);
    } catch (error) {
      // Only a 2xx ends the key. A refusal (4xx, 404, 429) keeps it and its flags, an unknown
      // outcome marks it; this runs even if the dialog unmounted meanwhile.
      if (isOutcomeUnknown(error)) {
        markActionOutcomeUnknown(action, sent.idempotencyKey, {
          reason: sent.reason,
          conflict: isIdempotencyConflict(error),
        });
      } else {
        endRefusedAttempt(action, sent.idempotencyKey);
      }
      setNotice(noticeOf(action));
      setBusy(false);
      setFailure(isApiError(error) ? t(error.messageKey) : t('admin.dialogs.failed'));
    }
  };

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-3.5">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={fieldId} className="text-xs leading-4 font-extrabold">
          {t('admin.dialogs.reason.label')}{' '}
          <span className="text-danger-text" aria-hidden="true">
            *
          </span>
          <span className="sr-only">({t('admin.dialogs.reason.required')})</span>
        </label>
        <textarea
          id={fieldId}
          value={reason}
          rows={3}
          maxLength={ADMIN_REASON_MAX_LENGTH + 50}
          placeholder={placeholder}
          aria-invalid={showIssue}
          aria-describedby={`${fieldId}-hint`}
          onChange={(event) => setReason(event.target.value)}
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
          {showIssue
            ? t(`admin.dialogs.reason.${issue}`, {
                min: ADMIN_REASON_MIN_LENGTH,
                max: ADMIN_REASON_MAX_LENGTH,
              })
            : t('admin.dialogs.reason.hint', { min: ADMIN_REASON_MIN_LENGTH })}
        </span>
      </div>
      {children}
      {notice !== null ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-sm bg-warning-soft px-3 py-2.5 text-[13px] leading-[18px] font-bold text-warning-text"
        >
          <Icon icon={CircleHelp} size={16} className="mt-px flex-none" />
          {t(`admin.dialogs.${notice}`)}
        </div>
      ) : null}
      {failure === null ? null : (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-sm bg-danger-soft px-3 py-2.5 text-[13px] leading-[18px] font-bold text-danger-text"
        >
          <Icon icon={CircleAlert} size={16} className="mt-px flex-none" />
          {failure}
        </div>
      )}
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
    </form>
  );
}
