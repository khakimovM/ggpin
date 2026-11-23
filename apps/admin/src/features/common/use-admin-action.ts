import type { AdminPermission } from '@repo/shared';
import { useToast } from '@repo/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { useAdmin } from '../../app/admin-context';
import { adminActionId, type AdminActionId, type AdminActionKind } from '../../lib/idempotency';
import { invalidationsFor } from '../../lib/query-keys';

/** What every admin write answers with (docs/04 «Javob»). */
export interface ActionResult {
  applied: boolean;
  auditId: string | null;
}

export type ResultKind = 'done' | 'replayed' | 'noChange';

/**
 * `applied: true` — done now; `applied: false` with an `auditId` — the first call's result (a
 * replay of the same key, or the twin that won); `applied: false` without one — the record was
 * already in the asked state and nothing was written.
 */
export function resultKind(result: ActionResult): ResultKind {
  if (result.applied) return 'done';
  return result.auditId === null ? 'noChange' : 'replayed';
}

/**
 * The shared wiring of the action dialogs: who acts, what they may do (UX only — the API decides),
 * the registry id of an action, and what happens after it: one toast and the invalidations.
 */
export function useAdminAction() {
  const me = useAdmin();
  const t = useTranslations();
  const toast = useToast();
  const queryClient = useQueryClient();

  const refresh = (kind: AdminActionKind) => {
    for (const queryKey of invalidationsFor(kind)) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };

  return {
    actor: { name: me.admin.name, role: me.admin.role },
    limits: me.limits,
    can: (permission: AdminPermission) => me.permissions.includes(permission),
    idOf: (kind: AdminActionKind, targetId: string): AdminActionId =>
      adminActionId(me.admin.id, kind, targetId),
    /** After a 2xx: says what happened (with an optional detail line) and refreshes. */
    finished: (kind: AdminActionKind, result: ActionResult, detail?: string) => {
      const outcome = resultKind(result);
      toast.show({
        tone: outcome === 'done' ? 'success' : 'info',
        title: t(`admin.dialogs.result.${outcome}`),
        ...(detail === undefined ? {} : { description: detail }),
      });
      refresh(kind);
    },
    /** The outcome check found the action's audit row: it was applied. */
    found: (kind: AdminActionKind) => {
      toast.show({ tone: 'success', title: t('admin.dialogs.outcome.found') });
      refresh(kind);
    },
  };
}
