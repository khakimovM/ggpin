import {
  ADMIN_REASON_MAX_LENGTH,
  ADMIN_REASON_MIN_LENGTH,
  AdminReasonSchema,
  type AdminRole,
} from '@repo/shared';
import { Button, Dialog, Icon, cn } from '@repo/ui';
import type { LucideIcon } from 'lucide-react';
import { CircleAlert, ScrollText } from 'lucide-react';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { isApiError } from '../../lib/api/errors';
import { createIdempotencyKey } from '../../lib/idempotency';

export interface ReasonSubmit {
  /** Trimmed, checked with the shared AdminReasonSchema (10-500 visible characters). */
  reason: string;
  /** Created when the dialog opened; the same for every retry of this one action. */
  idempotencyKey: string;
}

export interface ReasonDialogProps {
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

function reasonIssue(value: string): ReasonIssue | null {
  if (AdminReasonSchema.safeParse(value).success) return null;
  const length = value.trim().length;
  if (length < ADMIN_REASON_MIN_LENGTH) return 'tooShort';
  if (length > ADMIN_REASON_MAX_LENGTH) return 'tooLong';
  return 'invalid';
}

/**
 * Every admin action that changes something asks for a reason first (Admin.dc.html dialogs,
 * docs/04 `reason`). The form lives only while the dialog is open, so each opening starts empty
 * and gets its own Idempotency-Key.
 */
export function ReasonDialog(props: ReasonDialogProps) {
  const t = useTranslations();
  const [busy, setBusy] = useState(false);
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
  const [idempotencyKey] = useState(createIdempotencyKey);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const issue = reasonIssue(reason);
  const showIssue = touched && issue !== null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (issue !== null || !extraValid || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await onSubmit({ reason: reason.trim(), idempotencyKey });
      setBusy(false);
      onOpenChange(false);
    } catch (error) {
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
