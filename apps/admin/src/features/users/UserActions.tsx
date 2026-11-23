import type { AdminPermission, AdminUserDetailResponse } from '@repo/shared';
import { Button, Icon } from '@repo/ui';
import { Ban, LogOut, Scale, ShieldCheck, Snowflake, Sun } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { useAdminAction } from '../common/use-admin-action';
import { AdjustWalletDialog } from './AdjustWalletDialog';
import { UserStateDialog, type UserStateKind } from './UserStateDialog';

type Open = UserStateKind | 'users.adjustWallet' | null;

interface ActionButton {
  kind: Exclude<Open, null>;
  permission: AdminPermission;
  label: string;
  icon: LucideIcon;
  danger?: boolean;
}

/**
 * The action row of a user's page (AdminOps.dc.html `user`). A button shows only when the role
 * may use it (UX; the API checks again): block/freeze/sessions OPERATOR+, unblock/unfreeze and
 * the wallet OWNER (notes have their own panel). Block or unblock, freeze or unfreeze follow the state.
 */
export function UserActions({ user, name }: { user: AdminUserDetailResponse; name: string }) {
  const t = useTranslations();
  const act = useAdminAction();
  const [open, setOpen] = useState<Open>(null);
  const buttons: ActionButton[] = [
    user.isBlocked
      ? {
          kind: 'users.unblock',
          permission: 'users.unblock',
          label: t('admin.users.actions.unblock'),
          icon: ShieldCheck,
        }
      : {
          kind: 'users.block',
          permission: 'users.block',
          label: t('admin.users.actions.block'),
          icon: Ban,
          danger: true,
        },
    user.purchaseFrozen
      ? {
          kind: 'users.unfreeze',
          permission: 'users.unfreeze',
          label: t('admin.users.actions.unfreeze'),
          icon: Sun,
        }
      : {
          kind: 'users.freeze',
          permission: 'users.freeze',
          label: t('admin.users.actions.freeze'),
          icon: Snowflake,
        },
    {
      kind: 'users.adjustWallet',
      permission: 'users.adjustWallet',
      label: t('admin.users.actions.adjust'),
      icon: Scale,
    },
    {
      kind: 'users.sessionsRevoke',
      permission: 'users.sessionsRevoke',
      label: t('admin.users.actions.sessions'),
      icon: LogOut,
      danger: true,
    },
  ];
  const close = (next: boolean) => {
    if (!next) setOpen(null);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {buttons
        .filter((button) => act.can(button.permission))
        .map((button) => (
          <Button
            key={button.kind}
            variant="outline"
            size="sm"
            className={button.danger ? 'text-danger-text' : undefined}
            onClick={() => setOpen(button.kind)}
          >
            <Icon icon={button.icon} size={14} />
            {button.label}
          </Button>
        ))}
      {open === 'users.adjustWallet' ? (
        <AdjustWalletDialog user={user} name={name} open onOpenChange={close} />
      ) : open !== null ? (
        <UserStateDialog kind={open} user={user} name={name} open onOpenChange={close} />
      ) : null}
    </div>
  );
}
