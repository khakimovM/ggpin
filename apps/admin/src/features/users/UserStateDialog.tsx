import type { AdminUserDetailResponse } from '@repo/shared';
import { Ban, LogOut, ShieldCheck, Snowflake, Sun } from 'lucide-react';
import { useTranslations } from 'use-intl';
import {
  changeUserState,
  revokeUserSessions,
  type UserStateAction,
} from '../../lib/api/writes-users';
import { ReasonDialog } from '../common/ReasonDialog';
import { useAdminAction } from '../common/use-admin-action';

export type UserStateKind = UserStateAction | 'users.sessionsRevoke';

const LOOK = {
  'users.block': { dialog: 'block', icon: Ban, tone: 'danger' },
  'users.unblock': { dialog: 'unblock', icon: ShieldCheck, tone: 'primary' },
  'users.freeze': { dialog: 'freeze', icon: Snowflake, tone: 'primary' },
  'users.unfreeze': { dialog: 'unfreeze', icon: Sun, tone: 'primary' },
  'users.sessionsRevoke': { dialog: 'sessions', icon: LogOut, tone: 'danger' },
} as const;

interface Props {
  kind: UserStateKind;
  user: AdminUserDetailResponse;
  /** How the user is named in the texts (`@username` or the Telegram name). */
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Block / unblock / freeze / unfreeze / end sessions (AdminOps.dc.html `block`, `freeze`,
 * `sessions`): a reason and nothing else; no code (docs/04, D-63). Ending web sessions is part
 * of a block (D-63 (9)), so its toast says how many ended.
 */
export function UserStateDialog({ kind, user, name, open, onOpenChange }: Props) {
  const t = useTranslations();
  const act = useAdminAction();
  const look = LOOK[kind];
  const title = t(`admin.users.dialog.${look.dialog}.title`);
  const body =
    look.dialog === 'sessions'
      ? t('admin.users.dialog.sessions.body', { count: user.activeSessionsCount })
      : t(`admin.users.dialog.${look.dialog}.body`, { name });
  return (
    <ReasonDialog
      action={act.idOf(kind, user.id)}
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={body}
      icon={look.icon}
      tone={look.tone}
      submitLabel={t(`admin.users.dialog.${look.dialog}.cta`)}
      actor={act.actor}
      onOutcomeFound={(applied) => act.found(kind, applied)}
      onSubmit={async ({ reason, idempotencyKey }) => {
        const result =
          kind === 'users.sessionsRevoke'
            ? await revokeUserSessions(user.id, { reason }, idempotencyKey)
            : await changeUserState(kind, user.id, { reason }, idempotencyKey);
        const revoked = result.revokedSessions;
        act.finished(
          kind,
          result,
          revoked > 0 ? t('admin.users.result.revoked', { count: revoked }) : undefined,
        );
      }}
    />
  );
}
