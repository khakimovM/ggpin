import { describe, expect, it } from 'vitest';
import { notifyJobId, notifyJobSchema, type NotifyJob } from '../notify';
import {
  NO_EFFECTS,
  ORDER_EFFECTS_ACTIONS,
  effectsOf,
  orderEffectsPlan,
  type EffectsAuditRow,
  type EffectsOrder,
} from './order-effects-plan';
import { TON_TX_HINT_ACTION } from './tx-hint';

// Synthetic ids only.
const ORDER = 'cmorder1abc';
const AUDIT = 'cmaudit1abc';
const USER = 'cmuser1abc';
const TRANSFER = 'cmtransfer1abc';

const ids = (jobs: readonly NotifyJob[]): string[] =>
  jobs.map((job) => notifyJobId(notifyJobSchema.parse(job)));

function row(over: Partial<EffectsAuditRow>): EffectsAuditRow {
  return {
    id: AUDIT,
    action: ORDER_EFFECTS_ACTIONS.reviewResolve,
    targetType: 'Order',
    targetId: ORDER,
    actorType: 'CLI',
    after: null,
    ...over,
  };
}

function order(status: EffectsOrder['status'], id = ORDER): EffectsOrder {
  return { id, userId: USER, status };
}

const refundAfter = (proof: Record<string, unknown>) => ({
  proof,
  refund: { amountTiyin: '5000000', ledgerEntryId: 'cmledger1' },
});

describe('orderEffectsPlan: ORDER_REVIEW_RESOLVE', () => {
  it('delivered by an operator: customer notice, reviewResolved, adminAction; no cache', () => {
    const plan = orderEffectsPlan(
      row({ after: { proof: { kind: 'TON_TX' }, refund: null } }),
      order('DELIVERED'),
    );
    expect(ids(plan.notifyJobs)).toEqual([
      `order-${ORDER}-delivered`,
      `alert-reviewResolved-${ORDER}_${AUDIT}`,
      `alert-adminAction-${AUDIT}`,
    ]);
    expect(plan.invalidateWalletOf).toBeNull();
    expect(plan.requeueOrderId).toBeNull();
  });

  it('refunded: the owner wallet cache first, then ORDER_REFUNDED', () => {
    const plan = orderEffectsPlan(
      row({ after: refundAfter({ kind: 'TON_NOT_SENT' }) }),
      order('REFUNDED'),
    );
    expect(ids(plan.notifyJobs)).toEqual([
      `order-${ORDER}-refunded`,
      `alert-reviewResolved-${ORDER}_${AUDIT}`,
      `alert-adminAction-${AUDIT}`,
    ]);
    expect(plan.invalidateWalletOf).toBe(USER);
  });

  it('SENT_ELSEWHERE raises tonWalletCompromised with the transfer id, before reviewResolved', () => {
    const proof = {
      kind: 'TON_UNMATCHED_RESOLVED',
      finding: 'SENT_ELSEWHERE',
      transferId: TRANSFER,
    };
    const plan = orderEffectsPlan(row({ after: refundAfter(proof) }), order('REFUNDED'));
    expect(ids(plan.notifyJobs)).toEqual([
      `order-${ORDER}-refunded`,
      `alert-tonWalletCompromised-${TRANSFER}`,
      `alert-reviewResolved-${ORDER}_${AUDIT}`,
      `alert-adminAction-${AUDIT}`,
    ]);
  });

  it('NOT_SENT or another proof kind with a transferId is no security incident', () => {
    for (const proof of [
      { kind: 'TON_UNMATCHED_RESOLVED', finding: 'NOT_SENT', transferId: TRANSFER },
      { kind: 'TON_BOUNCED', finding: 'SENT_ELSEWHERE', transferId: TRANSFER },
      { kind: 'TON_UNMATCHED_RESOLVED', transferId: TRANSFER },
    ]) {
      const plan = orderEffectsPlan(row({ after: refundAfter(proof) }), order('REFUNDED'));
      expect(ids(plan.notifyJobs).some((id) => id.startsWith('alert-tonWalletCompromised'))).toBe(
        false,
      );
    }
  });

  it('the reconciler (actorType SYSTEM) gets no adminAction alert', () => {
    const plan = orderEffectsPlan(
      row({ actorType: 'SYSTEM', after: refundAfter({ kind: 'TON_NOT_SENT' }) }),
      order('REFUNDED'),
    );
    expect(ids(plan.notifyJobs)).toEqual([
      `order-${ORDER}-refunded`,
      `alert-reviewResolved-${ORDER}_${AUDIT}`,
    ]);
    expect(plan.invalidateWalletOf).toBe(USER);
  });

  it('no refund and the order is not DELIVERED (any more): no customer notice', () => {
    const plan = orderEffectsPlan(row({ after: { refund: null } }), order('REFUNDED'));
    expect(ids(plan.notifyJobs)).toEqual([
      `alert-reviewResolved-${ORDER}_${AUDIT}`,
      `alert-adminAction-${AUDIT}`,
    ]);
  });

  it('another order (wrong id) or none: no wallet, no delivered notice; alerts stay', () => {
    for (const other of [order('DELIVERED', 'cmother1abc'), null]) {
      const refunded = orderEffectsPlan(row({ after: refundAfter({ kind: 'MANUAL' }) }), other);
      expect(refunded.invalidateWalletOf).toBeNull();
      expect(ids(refunded.notifyJobs)[0]).toBe(`order-${ORDER}-refunded`);
      const delivered = orderEffectsPlan(row({ after: { refund: null } }), other);
      expect(ids(delivered.notifyJobs)).not.toContain(`order-${ORDER}-delivered`);
    }
  });

  it('a malformed after (not an object, array) plans no refund and no incident', () => {
    for (const after of [null, 'x', 42, [], { refund: 'yes', proof: [] }]) {
      const plan = orderEffectsPlan(row({ after }), order('FAILED'));
      expect(plan.invalidateWalletOf).toBeNull();
      expect(ids(plan.notifyJobs)).toEqual([
        `alert-reviewResolved-${ORDER}_${AUDIT}`,
        `alert-adminAction-${AUDIT}`,
      ]);
    }
  });
});

describe('orderEffectsPlan: other actions', () => {
  it('ORDER_RETRY: adminAction, and the order back to the enqueuer while still QUEUED', () => {
    const queued = orderEffectsPlan(row({ action: 'ORDER_RETRY' }), order('QUEUED'));
    expect(ids(queued.notifyJobs)).toEqual([`alert-adminAction-${AUDIT}`]);
    expect(queued.requeueOrderId).toBe(ORDER);
    expect(queued.invalidateWalletOf).toBeNull();
    for (const status of ['PROCESSING', 'HELD', 'DELIVERED'] as const) {
      expect(orderEffectsPlan(row({ action: 'ORDER_RETRY' }), order(status)).requeueOrderId).toBe(
        null,
      );
    }
    expect(orderEffectsPlan(row({ action: 'ORDER_RETRY' }), null).requeueOrderId).toBeNull();
  });

  it.each([
    [ORDER_EFFECTS_ACTIONS.fxSet, 'FxRate'],
    [TON_TX_HINT_ACTION, 'TonTransfer'],
  ])('%s (%s): adminAction only', (action, targetType) => {
    const plan = orderEffectsPlan(row({ action, targetType, targetId: 'cmtarget1abc' }), null);
    expect(ids(plan.notifyJobs)).toEqual([`alert-adminAction-${AUDIT}`]);
    expect(plan.invalidateWalletOf).toBeNull();
    expect(plan.requeueOrderId).toBeNull();
  });

  it.each(['ORDER_REFUND', 'WALLET_ADJUST', '', 'order_review_resolve'])(
    'unknown action %j plans nothing',
    (action) => {
      expect(orderEffectsPlan(row({ action }), order('REFUNDED'))).toEqual(NO_EFFECTS);
    },
  );
});

describe('orderEffectsPlan: the target type must be the one of the action (m3)', () => {
  it.each([
    [ORDER_EFFECTS_ACTIONS.reviewResolve, 'TonTransfer'],
    [ORDER_EFFECTS_ACTIONS.reviewResolve, 'order'],
    [ORDER_EFFECTS_ACTIONS.retry, 'User'],
    [ORDER_EFFECTS_ACTIONS.retry, ''],
    [ORDER_EFFECTS_ACTIONS.fxSet, 'Order'],
    [TON_TX_HINT_ACTION, 'Order'],
  ])('%s on a %j target plans nothing', (action, targetType) => {
    const after = refundAfter({ kind: 'TON_NOT_SENT' });
    expect(orderEffectsPlan(row({ action, targetType, after }), order('QUEUED'))).toEqual(
      NO_EFFECTS,
    );
  });

  it('the matching target type plans the action (control for the cases above)', () => {
    const plan = orderEffectsPlan(row({ action: ORDER_EFFECTS_ACTIONS.retry }), order('QUEUED'));
    expect(plan.requeueOrderId).toBe(ORDER);
  });
});

describe('effectsOf (the API passes what it knows after its own commit)', () => {
  it('REVIEW_RESOLVED and the same audit row plan the same jobs', () => {
    const proof = {
      kind: 'TON_UNMATCHED_RESOLVED',
      finding: 'SENT_ELSEWHERE',
      transferId: TRANSFER,
    };
    const fromRow = orderEffectsPlan(row({ after: refundAfter(proof) }), order('REFUNDED'));
    const fromFacts = effectsOf({
      kind: 'REVIEW_RESOLVED',
      orderId: ORDER,
      auditId: AUDIT,
      userId: USER,
      delivered: false,
      refunded: true,
      compromisedTransferId: TRANSFER,
      byOperator: true,
    });
    expect(fromFacts).toEqual(fromRow);
  });

  it('a refund without a known owner deletes no cache', () => {
    const plan = effectsOf({
      kind: 'REVIEW_RESOLVED',
      orderId: ORDER,
      auditId: AUDIT,
      userId: null,
      delivered: false,
      refunded: true,
      compromisedTransferId: null,
      byOperator: false,
    });
    expect(plan.invalidateWalletOf).toBeNull();
    expect(ids(plan.notifyJobs)).toEqual([
      `order-${ORDER}-refunded`,
      `alert-reviewResolved-${ORDER}_${AUDIT}`,
    ]);
  });
});
