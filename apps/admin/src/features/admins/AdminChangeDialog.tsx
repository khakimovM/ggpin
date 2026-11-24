import type { AdminAccount } from '@repo/shared';
import { PANEL_ASSIGNABLE_ROLES } from '@repo/shared';
import { UserCheck, UserCog, UserX } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { requestConfirmation } from '../../lib/api/confirmations';
import { NotSentError } from '../../lib/api/errors';
import { listAudit } from '../../lib/api/people';
import { updateAdmin } from '../../lib/api/writes-admins';
import { actionParts, pendingFields } from '../../lib/idempotency';
import { findActionAudit } from '../../lib/idempotency-outcome';
import { ConfirmCodeStep } from '../common/ConfirmCodeStep';
import { ReasonDialog } from '../common/ReasonDialog';
import { resultKind, useAdminAction } from '../common/use-admin-action';
import { useCodeStep } from '../common/use-code-step';
import { AdminRoleField, AdminTextField } from './AdminFields';
import {
  adminChangeOf,
  adminMatches,
  adminNameValid,
  roleFrom,
  textFrom,
  updateBody,
  updateConfirmation,
} from './admin-change-model';
import { useReplayCheck } from './use-replay-check';

export type AdminChangeMode = 'change' | 'deactivate' | 'reactivate';

/**
 * Three dialogs write `admins.update` on the same admin with different bodies, so each has its own
 * registry entry (S8b lesson, CR A2): an unknown outcome of one never hands its key to another.
 */
export function changeTargetOf(adminId: string, mode: AdminChangeMode): string {
  return mode === 'change' ? adminId : `${adminId}-${mode}`;
}

const LOOK: Record<AdminChangeMode, { icon: LucideIcon; tone: 'primary' | 'danger' }> = {
  change: { icon: UserCog, tone: 'primary' },
  deactivate: { icon: UserX, tone: 'danger' },
  reactivate: { icon: UserCheck, tone: 'primary' },
};

interface Props {
  admin: AdminAccount;
  mode: AdminChangeMode;
  onOpenChange: (open: boolean) => void;
}

/**
 * Rename or OPERATOR ↔ SUPPORT, deactivate, reactivate (docs/04 `PATCH /admin/admins/:id`). Only
 * the changed fields are sent and bound to the code; a role change or a deactivation ends the
 * admin's sessions on the server. Never opened for an OWNER row (Q7 a: CLI only).
 */
export function AdminChangeDialog({ admin, mode, onOpenChange }: Props) {
  const t = useTranslations();
  const act = useAdminAction();
  const replayed = useReplayCheck();
  const action = act.idOf('admins.update', changeTargetOf(admin.id, mode));
  const { adminId } = actionParts(action);
  const [sent] = useState(() => pendingFields(action));
  const assignable = PANEL_ASSIGNABLE_ROLES.find((role) => role === admin.role) ?? 'SUPPORT';
  const [name, setName] = useState(() => textFrom(sent, 'name', admin.name));
  const [role, setRole] = useState(() => roleFrom(sent, assignable));
  const wanted = mode === 'change' ? { name, role } : { isActive: mode === 'reactivate' };
  const change = mode === 'change' && !adminNameValid(name) ? null : adminChangeOf(admin, wanted);
  const confirmation = change === null ? null : updateConfirmation(admin.id, change);
  const code = useCodeStep(confirmation);
  const look = LOOK[mode];
  const nothing = mode === 'change' && adminNameValid(name) && change === null;
  return (
    <ReasonDialog
      action={action}
      open
      onOpenChange={onOpenChange}
      title={t(`admin.admins.dialog.${mode}.title`)}
      description={t(`admin.admins.dialog.${mode}.body`, { name: admin.name })}
      icon={look.icon}
      tone={look.tone}
      submitLabel={t(`admin.admins.dialog.${mode}.cta`)}
      actor={act.actor}
      extraValid={change !== null && code.otp !== null}
      fields={mode === 'change' ? { name, role } : { isActive: mode === 'reactivate' }}
      // The audit row names the admin itself, not the registry's `-deactivate` target.
      lookupOutcome={async (auditId) =>
        (await findActionAudit({ adminId, targetId: admin.id, auditId }, (query) =>
          listAudit(query),
        )) === 'found'
      }
      onOutcomeFound={() => act.found('admins.update')}
      onRestart={code.reset}
      onSubmit={async ({ reason, idempotencyKey }) => {
        if (change === null || code.otp === null) throw new NotSentError();
        try {
          const body = updateBody(change, reason, code.otp);
          const result = await updateAdmin(admin.id, body, idempotencyKey);
          // A replay is the old key's result, not the state now (CR-S9b-1): check it.
          if (resultKind(result) === 'replayed') {
            await replayed('admins.update', result, admin.id, (now) => adminMatches(now, change));
          } else {
            act.finished('admins.update', result);
          }
        } catch (error) {
          code.refused(error);
          throw error;
        }
      }}
    >
      {mode === 'change' ? (
        <div className="grid grid-cols-[minmax(0,1fr)_140px] items-start gap-2">
          <AdminTextField
            label={t('admin.admins.dialog.add.name')}
            value={name}
            onChange={setName}
            valid={adminNameValid(name)}
            error={t('admin.admins.dialog.add.nameInvalid')}
            showLabel
          />
          <AdminRoleField
            label={t('admin.admins.dialog.add.role')}
            value={role}
            onChange={setRole}
            showLabel
          />
        </div>
      ) : null}
      {nothing ? (
        <p className="m-0 text-xs leading-4 font-semibold text-foreground-muted">
          {t('admin.admins.dialog.change.nothing')}
        </p>
      ) : null}
      {mode === 'change' && change?.role !== undefined ? (
        <p role="status" className="m-0 text-xs leading-4 font-bold text-warning-text">
          {t('admin.admins.dialog.change.roleEndsSessions')}
        </p>
      ) : null}
      <ConfirmCodeStep
        key={code.binding}
        requestCode={() =>
          confirmation === null
            ? Promise.reject(new NotSentError())
            : requestConfirmation(confirmation)
        }
        onChange={code.setOtp}
        problem={code.problem}
        onCodeRequested={code.clearProblem}
        disabled={confirmation === null}
      />
    </ReasonDialog>
  );
}
