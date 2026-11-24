import { Button } from '@repo/ui';
import { useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import { voidWriteKey } from '../../lib/api/writes-keys';
import {
  pendingAction,
  pendingInFlight,
  registryVersion,
  subscribeRegistry,
  type AdminActionId,
} from '../../lib/idempotency';
import { resolveActionOutcome, type AppliedOutcome } from '../../lib/idempotency-outcome';

interface Props {
  action: AdminActionId;
  /** The action ran under the old key: its entry is settled already. */
  onApplied: (applied: AppliedOutcome) => void;
  /** The old key is dead on the server and a new one replaced it. */
  onVoided: () => void;
  /** The form is sending an attempt right now: no void meanwhile (N-1). */
  busy: boolean;
}

type State = 'idle' | 'resolving' | 'failed';

/**
 * «Natijani aniqlash» inside the unknown-outcome notice (docs/04, 9-B Q2 = A): voids this admin's
 * key. APPLIED — done; VOIDED — a new key at once; anything else keeps the key and says so. While
 * any attempt of the key is out there is no void at all: it may still commit after the answer.
 */
export function OutcomeCheck({ action, onApplied, onVoided, busy }: Props) {
  const t = useTranslations();
  const [state, setState] = useState<State>('idle');
  // Synchronous: two clicks in one tick send one void.
  const resolving = useRef(false);
  // F-1: an attempt ending elsewhere (a closed dialog's answer, a timeout) re-renders this.
  useSyncExternalStore(subscribeRegistry, registryVersion);
  if (pendingAction(action) === null) return null;
  const out = busy || pendingInFlight(action);

  const resolve = async () => {
    if (resolving.current || busy || pendingInFlight(action)) return;
    resolving.current = true;
    setState('resolving');
    const result = await resolveActionOutcome(action, voidWriteKey);
    resolving.current = false;
    if (result.kind === 'applied') {
      onApplied({ auditId: result.auditId, action: result.action });
    } else if (result.kind === 'voided') {
      setState('idle');
      onVoided();
    } else {
      setState(result.kind === 'failed' ? 'failed' : 'idle');
    }
  };

  return (
    <div className="flex flex-col gap-2 pl-6 text-xs leading-4 font-semibold">
      {state === 'failed' ? (
        <span role="alert">{t('admin.dialogs.outcome.voidFailed')}</span>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        loading={state === 'resolving'}
        disabled={out}
        onClick={() => void resolve()}
      >
        {state === 'resolving'
          ? t('admin.dialogs.outcome.resolving')
          : t('admin.dialogs.outcome.resolve')}
      </Button>
    </div>
  );
}
