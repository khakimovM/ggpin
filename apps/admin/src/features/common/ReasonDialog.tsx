import type { AdminRole } from '@repo/shared';
import { Dialog, Icon } from '@repo/ui';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import type { ActionFields, AdminActionId } from '../../lib/idempotency';
import { ReasonForm } from './ReasonForm';

export interface ReasonSubmit {
  /**
   * Trimmed text of the dialog's field, checked with the shared schema: the reason (10-500
   * visible characters), or the note text when `textField` is `note`.
   */
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
   * from `pendingFields(action)`, and never an OTP code.
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
  /** The extra fields as they will be sent: kept in memory with an unknown outcome (never a code). */
  fields?: ActionFields;
  /** `note`: the field is a note's text (1-1000 characters, docs/04 notes) instead of a reason. */
  textField?: 'reason' | 'note';
  /**
   * Where the outcome check looks for the action's row when the audit log is not readable
   * (SUPPORT notes: the user's `notes[].id`). Resolves true when the row is there.
   */
  lookupOutcome?: (auditId: string) => Promise<boolean>;
  /** The outcome check found the action done: the dialog closes; refresh and say so. */
  onOutcomeFound?: () => void;
  /** "Start as a new action" gave a new key: drop what was bound to the old one (the code). */
  onRestart?: () => void;
  /** Rejects with the API error to keep the dialog open and show it; resolves to close it. */
  onSubmit: (input: ReasonSubmit) => Promise<void>;
}

/**
 * Every admin action that changes something asks for a reason first (Admin.dc.html dialogs,
 * docs/04 `reason`). The form lives only while the dialog is open: an opening starts empty,
 * except after an unknown outcome, when what was sent is refilled from the registry (memory only)
 * so the same body can be resent. The Idempotency-Key lives in the registry by `action` until a
 * 2xx (lib/idempotency.ts). While a request is out, leaving the page asks first (I-2).
 */
export function ReasonDialog(props: ReasonDialogProps) {
  const t = useTranslations();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!busy) return;
    // A reload now would lose the answer; the key itself is already written ahead (SA M-2).
    // Both calls: preventDefault for current browsers, an empty returnValue for older ones (I-2).
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
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
