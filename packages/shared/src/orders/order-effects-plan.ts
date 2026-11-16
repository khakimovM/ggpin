// The after-commit effects of an audited order action, as ONE pure rule (phase 5 S9, D-64 (9)).
// The API's OrderAdminEffects queues them right after its own commit; the worker's audit-effects
// step (S9h) rebuilds them from the AuditLog row when the API crashed in between (I-3). Both take
// the jobs from here, so a replay carries exactly the ids of the first run and BullMQ drops the
// duplicate. Nothing here touches money: the REFUND entry and the state change were written in
// the action's own transaction; this only says who is told, which wallet cache is stale and which
// order goes back to fulfillment.
import type { NotifyJob } from '../notify';
import type { OrderStatus } from '../order-state';
import { TON_TX_HINT_ACTION } from './tx-hint';

/** The audited actions that have effects (`AuditLog.action`). Anything else plans nothing. */
export const ORDER_EFFECTS_ACTIONS = {
  reviewResolve: 'ORDER_REVIEW_RESOLVE',
  retry: 'ORDER_RETRY',
  fxSet: 'FX_SET',
  tonTxHint: TON_TX_HINT_ACTION,
} as const;
type OrderEffectsAction = (typeof ORDER_EFFECTS_ACTIONS)[keyof typeof ORDER_EFFECTS_ACTIONS];

/**
 * The `AuditLog.targetType` each action is written with (order-admin.repository.ts,
 * needs-review-resolve.ts, fx-admin.repository.ts, the S9f hint command). A row of a known action
 * with another target type plans nothing: its `targetId` is not what the plan would take it for.
 */
const TARGET_TYPE_OF: Readonly<Record<OrderEffectsAction, string>> = Object.freeze({
  [ORDER_EFFECTS_ACTIONS.reviewResolve]: 'Order',
  [ORDER_EFFECTS_ACTIONS.retry]: 'Order',
  [ORDER_EFFECTS_ACTIONS.fxSet]: 'FxRate',
  [ORDER_EFFECTS_ACTIONS.tonTxHint]: 'TonTransfer',
});

/** The row's action when it is one with effects AND written on its own target type, else null. */
function effectsActionOf(audit: EffectsAuditRow): OrderEffectsAction | null {
  const action = Object.values(ORDER_EFFECTS_ACTIONS).find((known) => known === audit.action);
  return action !== undefined && TARGET_TYPE_OF[action] === audit.targetType ? action : null;
}

/** `AuditLog.actorType` of a row the system wrote (the reconciler): no `adminAction` alert. */
const SYSTEM_ACTOR = 'SYSTEM';

/** The AuditLog columns the plan reads. `after` is the stored JSON, read defensively. */
export interface EffectsAuditRow {
  readonly id: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly actorType: string;
  readonly after: unknown;
}

/** The order the row is about, read by the caller (ignored unless its id is the row's target). */
export interface EffectsOrder {
  readonly id: string;
  readonly userId: string;
  readonly status: OrderStatus;
}

export interface OrderEffectsPlan {
  /** In the order they are queued; each producer validates a job (notifyJobSchema) before `add`. */
  readonly notifyJobs: readonly NotifyJob[];
  /** The user whose `wallet:{userId}` cache is deleted first (a REFUND entry was written). */
  readonly invalidateWalletOf: string | null;
  /**
   * The order handed to the fulfill-order enqueuer (jobId = orderId). The API's OrderRetryService
   * still requeues BEFORE its adminAction job (S10); moving retry onto `effectsOf` is S9b. The
   * order of the two carries no meaning: every id is stable.
   */
  readonly requeueOrderId: string | null;
}

/** What an action did, the input of `effectsOf`. The API knows it first hand after its commit. */
export type OrderEffectsFacts =
  | {
      /** A NEEDS_REVIEW order left review (ORDER_REVIEW_RESOLVE). */
      readonly kind: 'REVIEW_RESOLVED';
      readonly orderId: string;
      readonly auditId: string;
      /** The order's owner; null when it could not be read (no cache to delete then). */
      readonly userId: string | null;
      readonly delivered: boolean;
      /** The resolution wrote the REFUND entry. */
      readonly refunded: boolean;
      /** TON_UNMATCHED_RESOLVED with SENT_ELSEWHERE: the transfer of the security alert. */
      readonly compromisedTransferId: string | null;
      /** An operator (CLI or admin panel) acted, not the reconciler. */
      readonly byOperator: boolean;
    }
  | {
      /** A HELD order was released to QUEUED (ORDER_RETRY). */
      readonly kind: 'RELEASED';
      readonly orderId: string;
      readonly auditId: string;
      /** The order is still QUEUED: hand it to the enqueuer. */
      readonly requeue: boolean;
      readonly byOperator: boolean;
    }
  | {
      /** Any other audited owner action (FX_SET, TON_TX_HINT): the owner's own alert only. */
      readonly kind: 'ADMIN_ACTION';
      readonly auditId: string;
      readonly byOperator: boolean;
    };

export const NO_EFFECTS: OrderEffectsPlan = Object.freeze({
  notifyJobs: Object.freeze([]),
  invalidateWalletOf: null,
  requeueOrderId: null,
});

function alert(
  name: 'tonWalletCompromised' | 'reviewResolved' | 'adminAction',
  refId: string,
): NotifyJob {
  return { kind: 'OWNER_ALERT', alert: name, refId };
}

/**
 * The jobs of an action, in the order they are queued (OrderAdminEffects.afterResolve's order): the
 * customer's notice, the critical security alert, `reviewResolved` (`<orderId>_<auditId>`, so a
 * later review of the same order is a new alert), then the owner's `adminAction` (auditId) unless
 * the reconciler acted.
 */
export function effectsOf(facts: OrderEffectsFacts): OrderEffectsPlan {
  const owner = facts.byOperator ? [alert('adminAction', facts.auditId)] : [];
  switch (facts.kind) {
    case 'REVIEW_RESOLVED': {
      const jobs: NotifyJob[] = [];
      if (facts.delivered) jobs.push({ kind: 'ORDER_DELIVERED', refId: facts.orderId });
      else if (facts.refunded) jobs.push({ kind: 'ORDER_REFUNDED', refId: facts.orderId });
      if (facts.compromisedTransferId !== null) {
        jobs.push(alert('tonWalletCompromised', facts.compromisedTransferId));
      }
      jobs.push(alert('reviewResolved', `${facts.orderId}_${facts.auditId}`), ...owner);
      return {
        notifyJobs: jobs,
        invalidateWalletOf: facts.refunded ? facts.userId : null,
        requeueOrderId: null,
      };
    }
    case 'RELEASED':
      return {
        notifyJobs: owner,
        invalidateWalletOf: null,
        requeueOrderId: facts.requeue ? facts.orderId : null,
      };
    case 'ADMIN_ACTION':
      return { notifyJobs: owner, invalidateWalletOf: null, requeueOrderId: null };
  }
}

type JsonObject = { readonly [key: string]: unknown };

function objectOf(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function textOf(object: JsonObject | null, key: string): string | null {
  const value = object?.[key];
  return typeof value === 'string' ? value : null;
}

/**
 * The transfer of a stored TON_UNMATCHED_RESOLVED proof whose finding is SENT_ELSEWHERE (owner
 * decision A3: value left to an address that is not ours), else null. NOT_SENT is no incident.
 */
function compromisedTransferOf(proof: JsonObject | null): string | null {
  if (textOf(proof, 'kind') !== 'TON_UNMATCHED_RESOLVED') return null;
  if (textOf(proof, 'finding') !== 'SENT_ELSEWHERE') return null;
  return textOf(proof, 'transferId');
}

/**
 * The effects of one AuditLog row (the worker's I-3 sweep). `order` is the row's target order,
 * read by the caller; one with another id is ignored (a wallet is only ever the target's owner's).
 * ORDER_REVIEW_RESOLVE: the stored `after.refund` says a REFUND was written (the customer hears
 * ORDER_REFUNDED); otherwise the customer hears ORDER_DELIVERED only while the order IS delivered.
 * ORDER_RETRY: back to the enqueuer only while the order is still QUEUED. Unknown action, or a
 * known action whose target type is not its own (TARGET_TYPE_OF): nothing.
 */
export function orderEffectsPlan(
  audit: EffectsAuditRow,
  order: EffectsOrder | null,
): OrderEffectsPlan {
  const action = effectsActionOf(audit);
  if (action === null) return NO_EFFECTS;
  const target = order !== null && order.id === audit.targetId ? order : null;
  const byOperator = audit.actorType !== SYSTEM_ACTOR;
  const after = objectOf(audit.after);
  switch (action) {
    case ORDER_EFFECTS_ACTIONS.reviewResolve: {
      const refunded = objectOf(after?.['refund']) !== null;
      return effectsOf({
        kind: 'REVIEW_RESOLVED',
        orderId: audit.targetId,
        auditId: audit.id,
        userId: target?.userId ?? null,
        delivered: !refunded && target?.status === 'DELIVERED',
        refunded,
        compromisedTransferId: compromisedTransferOf(objectOf(after?.['proof'])),
        byOperator,
      });
    }
    case ORDER_EFFECTS_ACTIONS.retry:
      return effectsOf({
        kind: 'RELEASED',
        orderId: audit.targetId,
        auditId: audit.id,
        requeue: target?.status === 'QUEUED',
        byOperator,
      });
    case ORDER_EFFECTS_ACTIONS.fxSet:
    case ORDER_EFFECTS_ACTIONS.tonTxHint:
      return effectsOf({ kind: 'ADMIN_ACTION', auditId: audit.id, byOperator });
  }
}
