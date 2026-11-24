import type { AdminAccount } from '@repo/shared';
import { useToast } from '@repo/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { listAdmins } from '../../lib/api/reads';
import type { AdminActionKind } from '../../lib/idempotency';
import { invalidationsFor, qk } from '../../lib/query-keys';
import { useAdminAction, type ActionResult } from '../common/use-admin-action';

/**
 * CR-S9b-1, the minimal S9b part (the void-based fix is 9B-3). A replayed answer (`applied:false`
 * with an `auditId`) is the first call's result under an old key, not the state now: after an
 * unknown deactivation, a reactivation and a new deactivation, the old key comes back and the admin
 * stays active. So the list is reloaded, and unless the admin is in the asked state the panel warns
 * instead of reporting success. ReasonForm settles the key on this 2xx, so the next try goes with a
 * new key; no count or detail of the first call is shown.
 */
export function useReplayCheck() {
  const t = useTranslations();
  const toast = useToast();
  const queryClient = useQueryClient();
  const act = useAdminAction();
  return async (
    kind: AdminActionKind,
    result: ActionResult,
    adminId: string,
    holds: (admin: AdminAccount) => boolean,
  ): Promise<void> => {
    let fresh: AdminAccount | undefined;
    try {
      const list = await queryClient.fetchQuery({
        queryKey: qk.admins.list(),
        queryFn: ({ signal }) => listAdmins(signal),
        staleTime: 0,
      });
      fresh = list.find((row) => row.id === adminId);
    } catch {
      // Not proven either way: warn, as for a changed state.
      fresh = undefined;
    }
    if (fresh !== undefined && holds(fresh)) {
      act.finished(kind, result);
      return;
    }
    for (const queryKey of invalidationsFor(kind)) {
      void queryClient.invalidateQueries({ queryKey });
    }
    toast.show({ tone: 'warning', title: t('admin.admins.replayStale') });
  };
}
