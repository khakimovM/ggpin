import type { AdminAccount } from '@repo/shared';
import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { isActionOutcomeUnknown, NotSentError } from '../../lib/api/errors';
import { requestConfirmation } from '../../lib/api/confirmations';
import { listAudit } from '../../lib/api/people';
import { createAdmin } from '../../lib/api/writes-admins';
import { actionParts, pendingAction, pendingFields } from '../../lib/idempotency';
import { findActionAudit } from '../../lib/idempotency-outcome';
import { ConfirmCodeStep } from '../common/ConfirmCodeStep';
import { ReasonDialog } from '../common/ReasonDialog';
import { useAdminAction } from '../common/use-admin-action';
import { useCodeStep } from '../common/use-code-step';
import { AdminRoleField, AdminTextField } from './AdminFields';
import {
  adminNameValid,
  createBody,
  createConfirmation,
  newAdminOf,
  roleFrom,
  telegramIdValid,
  textFrom,
} from './admin-change-model';

/**
 * The registry target of "add an admin": the new admin has no id yet, and one dialog adds one
 * admin at a time, so the key belongs to the dialog until a 2xx. Its audit row names the new
 * admin, so the outcome check looks for this admin's ADMIN_CREATE rows instead.
 */
export const ADD_ADMIN_TARGET = 'new';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After a 2xx: the admin as the API stored it (`allowlisted: false` needs devops). */
  onCreated: (admin: AdminAccount) => void;
}

export function AddAdminDialog(props: Props) {
  return props.open ? <AddAdminOpen {...props} /> : null;
}

/**
 * «Admin qo‘shish» (AdminOps.dc.html `addAdmin`, D-63 (4), (6)): Telegram ID, a name (Q10, not in
 * the frame), OPERATOR or SUPPORT, a reason and the OWNER's code, which is bound to all three.
 */
function AddAdminOpen({ onOpenChange, onCreated }: Props) {
  const t = useTranslations();
  const act = useAdminAction();
  const action = act.idOf('admins.create', ADD_ADMIN_TARGET);
  const { adminId } = actionParts(action);
  const [sent] = useState(() => pendingFields(action));
  const [telegramId, setTelegramId] = useState(() => textFrom(sent, 'telegramId', ''));
  const [name, setName] = useState(() => textFrom(sent, 'name', ''));
  const [role, setRole] = useState(() => roleFrom(sent, 'SUPPORT'));
  // SA-I2: while the outcome is unknown the key is bound to the body sent; the fields stay as sent,
  // and another admin is added only as a new action (a new key).
  const [locked, setLocked] = useState(() => pendingAction(action)?.unknown === true);
  const admin = newAdminOf({ telegramId, name, role });
  const confirmation = admin === null ? null : createConfirmation(admin);
  const code = useCodeStep(confirmation);
  return (
    <ReasonDialog
      action={action}
      open
      onOpenChange={onOpenChange}
      title={t('admin.admins.dialog.add.title')}
      description={t('admin.admins.dialog.add.body')}
      icon={UserPlus}
      submitLabel={t('admin.admins.dialog.add.cta')}
      actor={act.actor}
      extraValid={admin !== null && code.otp !== null}
      fields={{ telegramId, name, role }}
      lookupOutcome={async (auditId) =>
        (await findActionAudit({ adminId, targetId: ADD_ADMIN_TARGET, auditId }, (query) =>
          listAudit({
            actorId: query.actorId,
            action: 'ADMIN_CREATE',
            page: query.page,
            limit: query.limit,
          }),
        )) === 'found'
      }
      onOutcomeFound={() => act.found('admins.create')}
      onRestart={() => {
        code.reset();
        setLocked(false);
      }}
      onSubmit={async ({ reason, idempotencyKey }) => {
        if (admin === null || code.otp === null) throw new NotSentError();
        try {
          const result = await createAdmin(createBody(admin, reason, code.otp), idempotencyKey);
          act.finished('admins.create', result);
          onCreated(result.admin);
        } catch (error) {
          if (isActionOutcomeUnknown(error)) setLocked(true);
          code.refused(error);
          throw error;
        }
      }}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_140px] items-start gap-2">
        <AdminTextField
          label={t('admin.admins.dialog.add.telegramId')}
          value={telegramId}
          onChange={setTelegramId}
          valid={telegramIdValid(telegramId)}
          error={t('admin.admins.dialog.add.telegramIdInvalid')}
          mono
          disabled={locked}
        />
        <AdminRoleField
          label={t('admin.admins.dialog.add.role')}
          value={role}
          onChange={setRole}
          disabled={locked}
        />
      </div>
      <AdminTextField
        label={t('admin.admins.dialog.add.name')}
        value={name}
        onChange={setName}
        valid={adminNameValid(name)}
        error={t('admin.admins.dialog.add.nameInvalid')}
        disabled={locked}
      />
      {/* The code is bound to the new admin: it opens once the fields are valid (the frame shows it). */}
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
