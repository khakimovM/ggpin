// "Did my action run?" after an unknown outcome (docs/04 «Idempotency-Key» (e), 9-B Q2 = A): the
// panel voids its own key. The API answers from the key's audit row id (the primary key decides
// the race with the old request): APPLIED — the action committed; VOIDED — it never will, so a new
// key may be used at once. No wait and no audit search: anything but one of those two answers is
// "no verdict" and the key stays.
import type { AdminWriteKeyVoidResponse } from '@repo/shared';
import type { VoidWriteKey } from './api/writes-keys';
import {
  actionParts,
  pendingAction,
  pendingInFlight,
  pendingVoidTarget,
  replaceVoidedKey,
  settleActionIdempotencyKey,
  type AdminActionId,
} from './idempotency';

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The audit row id the API gives the write sent with `key` by `adminId`:
 * `a` + the first 31 hex characters of sha256(`<adminId>|<key>`) (`adminAuditIdFor` on the API;
 * the golden vector is shared by both test suites). The dev mock derives its ids with it.
 */
export async function expectedAuditId(adminId: string, key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${adminId}|${key}`),
  );
  return `a${hex(digest).slice(0, 31)}`;
}

type Applied = Extract<AdminWriteKeyVoidResponse, { status: 'APPLIED' }>;

/** The action ran under the old key: its own audit row and `AuditLog.action`. */
export type AppliedOutcome = Pick<Applied, 'auditId' | 'action'>;

export type OutcomeResolution =
  /** Committed: the entry is settled (the next action gets a new key). */
  | ({ kind: 'applied' } & AppliedOutcome)
  /** Never will commit: the entry holds `key`, a new one. */
  | { kind: 'voided'; key: string }
  /** An attempt of the key is out in this tab (N-1): no void was sent. */
  | { kind: 'out' }
  /**
   * No verdict (a 404 — role, session, CSRF —, a 503 deadline, no answer, a timeout, anything
   * else): the key stays and the void may be asked again. Never read as "voided" (9B-1 SA).
   */
  | { kind: 'failed' };

/**
 * Voids the key of `action` and applies the verdict to the registry. Refused without a request
 * while an attempt with the key is out: that attempt may still commit after the void's answer.
 */
export async function resolveActionOutcome(
  action: AdminActionId,
  send: VoidWriteKey,
): Promise<OutcomeResolution> {
  const pending = pendingAction(action);
  if (pending === null) return { kind: 'failed' };
  if (pendingInFlight(action)) return { kind: 'out' };
  const { key } = pending;
  let answer: AdminWriteKeyVoidResponse;
  try {
    answer = await send({
      idempotencyKey: key,
      action: actionParts(action).kind,
      targetId: pendingVoidTarget(action),
    });
  } catch {
    return { kind: 'failed' };
  }
  // SA L-1: the verdict must be about THIS key. The API names the key's own audit row; any other
  // id (a server or proxy mix-up) is no verdict, or a committed money action could look voided.
  if (answer.auditId !== (await expectedAuditId(actionParts(action).adminId, key))) {
    return { kind: 'failed' };
  }
  if (answer.status === 'APPLIED') {
    settleActionIdempotencyKey(action, key);
    return { kind: 'applied', auditId: answer.auditId, action: answer.action };
  }
  const next = replaceVoidedKey(action, key);
  return next === null ? { kind: 'failed' } : { kind: 'voided', key: next };
}
