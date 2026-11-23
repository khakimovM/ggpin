import { Button } from '@repo/ui';
import { useContext, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import { AdminContext } from '../../app/admin-context';
import { listAudit } from '../../lib/api/people';
import {
  actionParts,
  pendingAction,
  pendingAttemptMark,
  pendingElapsedMs,
  pendingInFlight,
  registryVersion,
  restartAction,
  subscribeRegistry,
  type AdminActionId,
} from '../../lib/idempotency';
import {
  OUTCOME_WAIT_MS,
  expectedAuditId,
  findActionAudit,
  startNewAllowed,
} from '../../lib/idempotency-outcome';
import { useCountdown } from '../../lib/use-countdown';

interface Props {
  action: AdminActionId;
  /** Looks for the row elsewhere (SUPPORT notes); otherwise the audit log, when readable. */
  lookupOutcome?: (auditId: string) => Promise<boolean>;
  /** The row exists: the action with `key` was applied. */
  onFound: (key: string) => void;
  /** A new key replaced the old one. */
  onRestarted: () => void;
  /** The form is sending an attempt right now: no search and no new key meanwhile (N-1). */
  busy: boolean;
}

type State =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'failed' }
  /**
   * `elapsed`: since the last attempt left or ended when the search started (SA-2, R-3, N-1);
   * `mark`: the attempt state it was made in (R-1, N-1). A later attempt with the same key, or the
   * end of one, voids this verdict.
   */
  | { kind: 'notFound'; elapsed: number; waitUntil: number; mark: string };

/**
 * "Did it run?" inside the unknown-outcome notice (Q1 = A, SA L-1). It looks for the audit row
 * the key would have written; found = done. A new key is offered only by a search that ran at
 * least 60 s after the last attempt left or ended (OUTCOME_WAIT_MS): before that it waits and checks
 * again. While any attempt of the key is out (N-1) there is no search at all: it may still apply.
 */
export function OutcomeCheck({ action, lookupOutcome, onFound, onRestarted, busy }: Props) {
  const t = useTranslations();
  const me = useContext(AdminContext);
  const [held, setState] = useState<State>({ kind: 'idle' });
  // F-1: an attempt ending elsewhere (a closed dialog's answer, a timeout) re-renders this.
  useSyncExternalStore(subscribeRegistry, registryVersion);
  const pending = pendingAction(action);
  const mark = pendingAttemptMark(action);
  // R-1: a "not found" made before the last attempt says nothing about it: search again.
  const state: State = held.kind === 'notFound' && held.mark !== mark ? { kind: 'idle' } : held;
  const out = busy || pendingInFlight(action);
  const waiting = state.kind === 'notFound' && !startNewAllowed(state.elapsed);
  const left = useCountdown(waiting ? state.waitUntil : null);
  const readsAudit = me?.permissions.includes('audit.read') ?? false;
  if (pending === null || mark === null || (lookupOutcome === undefined && !readsAudit)) {
    return null;
  }
  const { key } = pending;

  const check = async () => {
    if (pendingInFlight(action)) return;
    setState({ kind: 'checking' });
    // Read before the search (R-3): the verdict covers the attempts made up to this moment.
    const elapsed = pendingElapsedMs(action) ?? 0;
    const searchedAfter = mark;
    try {
      const { adminId, targetId } = actionParts(action);
      const auditId = await expectedAuditId(adminId, key);
      const found = lookupOutcome
        ? await lookupOutcome(auditId)
        : (await findActionAudit({ adminId, targetId, auditId }, (query) => listAudit(query))) ===
          'found';
      if (found) onFound(key);
      else {
        const waitUntil = Date.now() + Math.max(0, OUTCOME_WAIT_MS - elapsed);
        setState({ kind: 'notFound', elapsed, waitUntil, mark: searchedAfter });
      }
    } catch {
      setState({ kind: 'failed' });
    }
  };

  const startNew = () => {
    if (state.kind !== 'notFound') return;
    if (restartAction(action, key, OUTCOME_WAIT_MS, state.mark, state.elapsed) !== null) {
      onRestarted();
    } else setState({ kind: 'idle' });
  };

  if (state.kind === 'notFound' && !waiting) {
    return (
      <div className="flex flex-col gap-2 pl-6 text-xs leading-4 font-semibold">
        <span>{t('admin.dialogs.outcome.notFound')}</span>
        <span>{t('admin.dialogs.outcome.startNewHint')}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          disabled={out}
          onClick={startNew}
        >
          {t('admin.dialogs.outcome.startNew')}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 pl-6 text-xs leading-4 font-semibold">
      {waiting ? (
        <span className="tabular-nums">
          {t('admin.dialogs.outcome.wait', { seconds: Math.ceil(left / 1000) })}
        </span>
      ) : null}
      {state.kind === 'failed' ? (
        <span role="alert">{t('admin.dialogs.outcome.checkFailed')}</span>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        loading={state.kind === 'checking'}
        disabled={out || (waiting && left > 0)}
        onClick={() => void check()}
      >
        {state.kind === 'checking'
          ? t('admin.dialogs.outcome.checking')
          : t('admin.dialogs.outcome.check')}
      </Button>
    </div>
  );
}
