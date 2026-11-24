import type { AdminAccount, AdminSessionsRevokeResponse } from '@repo/shared';
import { LogOut } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { endCurrentSession } from '../../lib/api/client';
import { requestConfirmation } from '../../lib/api/confirmations';
import { NotSentError } from '../../lib/api/errors';
import { revokeAdminSession, revokeAdminSessions } from '../../lib/api/writes-admins';
import { ConfirmCodeStep } from '../common/ConfirmCodeStep';
import { ReasonDialog } from '../common/ReasonDialog';
import { resultKind, useAdminAction } from '../common/use-admin-action';
import { useCodeStep } from '../common/use-code-step';
import { useReplayCheck } from './use-replay-check';

/** All sessions of one admin, or one session (a row of «Faol sessiyalar»). */
export type RevokeTarget =
  | { kind: 'admin'; admin: Pick<AdminAccount, 'id' | 'name' | 'role' | 'activeSessions'> }
  | {
      kind: 'session';
      sessionId: string;
      adminName: string;
      adminRole: AdminAccount['role'];
      device: string;
      current: boolean;
    };

interface Props {
  target: RevokeTarget;
  onOpenChange: (open: boolean) => void;
}

/**
 * Ending sessions (docs/04 `.../sessions/revoke`, the code always, D-63 (4)). An OWNER's sessions
 * too (Q7 b): the server alerts the owners. When the answer says this tab's own session was among
 * them (`currentRevoked`), the cookie is gone already: the panel goes to the login page.
 */
export function RevokeSessionsDialog({ target, onOpenChange }: Props) {
  const t = useTranslations();
  const act = useAdminAction();
  const replayed = useReplayCheck();
  const kind = target.kind === 'admin' ? 'admins.sessionsRevoke' : 'sessions.revoke';
  const targetId = target.kind === 'admin' ? target.admin.id : target.sessionId;
  const action = act.idOf(kind, targetId);
  const confirmation = { action: kind, targetId } as const;
  const code = useCodeStep(confirmation);
  const owner = (target.kind === 'admin' ? target.admin.role : target.adminRole) === 'OWNER';
  const dialog = target.kind === 'admin' ? 'revokeAll' : 'revokeSession';
  const description =
    target.kind === 'admin'
      ? t('admin.admins.dialog.revokeAll.body', {
          name: target.admin.name,
          count: target.admin.activeSessions,
        })
      : t('admin.admins.dialog.revokeSession.body', {
          name: target.adminName,
          device: target.device,
        });

  const done = async (result: AdminSessionsRevokeResponse) => {
    // Own session first: the cache is dropped before the refresh, so nothing refetches with a
    // cookie that no longer exists; the toast still says what happened.
    if (result.currentRevoked) {
      endCurrentSession();
      act.finished(kind, result, t('admin.admins.currentRevoked'));
    } else if (resultKind(result) !== 'replayed') {
      act.finished(
        kind,
        result,
        t('admin.admins.dialog.revokeAll.result', { count: result.revokedSessions }),
      );
    } else if (target.kind === 'admin') {
      // The old key's count is not shown (CR-S9b-1); sessions opened since stay open: check.
      await replayed(kind, result, target.admin.id, (now) => now.activeSessions === 0);
    } else {
      // One ended session never comes back: the replay is the truth, only its count is old.
      act.finished(kind, result);
    }
  };

  return (
    <ReasonDialog
      action={action}
      open
      onOpenChange={onOpenChange}
      title={t(`admin.admins.dialog.${dialog}.title`)}
      description={description}
      icon={LogOut}
      tone="danger"
      submitLabel={t(`admin.admins.dialog.${dialog}.cta`)}
      actor={act.actor}
      extraValid={code.otp !== null}
      onOutcomeFound={(applied) => act.found(kind, applied)}
      onRestart={code.reset}
      onSubmit={async ({ reason, idempotencyKey }) => {
        if (code.otp === null) throw new NotSentError();
        const body = { reason, otp: code.otp };
        try {
          await done(
            target.kind === 'admin'
              ? await revokeAdminSessions(targetId, body, idempotencyKey)
              : await revokeAdminSession(targetId, body, idempotencyKey),
          );
        } catch (error) {
          code.refused(error);
          throw error;
        }
      }}
    >
      {owner ? (
        <p className="m-0 text-xs leading-4 font-bold text-warning-text">
          {t('admin.admins.dialog.revokeAll.ownerAlert')}
        </p>
      ) : null}
      {target.kind === 'session' && target.current ? (
        <p className="m-0 text-xs leading-4 font-bold text-danger-text">
          {t('admin.admins.dialog.revokeSession.current')}
        </p>
      ) : null}
      <ConfirmCodeStep
        key={code.binding}
        requestCode={() => requestConfirmation(confirmation)}
        onChange={code.setOtp}
        problem={code.problem}
        onCodeRequested={code.clearProblem}
      />
    </ReasonDialog>
  );
}
