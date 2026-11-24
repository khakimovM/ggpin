import type { AdminAccount } from '@repo/shared';
import { UserPlus } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import { NotSentError } from '../../lib/api/errors';
import { requestConfirmation } from '../../lib/api/confirmations';
import { createAdmin } from '../../lib/api/writes-admins';
import {
  pendingAction,
  pendingFields,
  pendingInFlight,
  registryVersion,
  subscribeRegistry,
} from '../../lib/idempotency';
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
 * admin at a time, so the key belongs to the dialog until a 2xx. The key void names the new
 * admin's Telegram ID instead (docs/04), stored with the key so a reload keeps it.
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
  const [sent] = useState(() => pendingFields(action));
  const [telegramId, setTelegramId] = useState(() => textFrom(sent, 'telegramId', ''));
  const [name, setName] = useState(() => textFrom(sent, 'name', ''));
  const [role, setRole] = useState(() => roleFrom(sent, 'SUPPORT'));
  // SA-I2, RC-I1: while an attempt is out or its outcome is unknown the key is bound to the body
  // sent; the fields stay as sent until the void settles it. Read from the registry on every
  // change, so closing and reopening the dialog mid-flight keeps them locked too.
  useSyncExternalStore(subscribeRegistry, registryVersion);
  const unknown = pendingAction(action)?.unknown === true;
  const locked = unknown || pendingInFlight(action);
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
      {...(telegramIdValid(telegramId) ? { voidTargetId: telegramId.trim() } : {})}
      onOutcomeFound={(applied) => act.found('admins.create', applied)}
      onRestart={code.reset}
      onSubmit={async ({ reason, idempotencyKey }) => {
        if (admin === null || code.otp === null) throw new NotSentError();
        try {
          const result = await createAdmin(createBody(admin, reason, code.otp), idempotencyKey);
          act.finished('admins.create', result);
          onCreated(result.admin);
        } catch (error) {
          code.refused(error);
          throw error;
        }
      }}
    >
      {/* R-3: after a reload the fields sent are gone (memory only); say why the form is locked. */}
      {unknown && sent === null ? (
        <p className="m-0 text-xs leading-4 font-bold text-warning-text">
          {t('admin.admins.dialog.add.lockedUnknown')}
        </p>
      ) : null}
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
