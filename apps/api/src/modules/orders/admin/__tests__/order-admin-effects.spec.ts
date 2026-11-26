import {
  NOTIFY_JOB_NAME,
  ORDER_EFFECTS_ACTIONS,
  notifyJobId,
  notifyJobSchema,
  orderEffectsPlan,
  type NotifyJob,
} from '@repo/shared';
import type { Queue } from 'bullmq';
import { FX_SET_ACTION } from '../../../fx-admin/fx-admin.repository';
import type { WalletCache } from '../../../wallet/wallet-cache';
import type { FulfillOrderEnqueuer } from '../../../../infra/queue/fulfill-order-enqueuer';
import {
  OrderAdminEffects,
  type EffectsReport,
  type ResolvedEffects,
} from '../order-admin-effects';
import { ORDER_RETRY_ACTION, REVIEW_RESOLVE_ACTION } from '../order-admin.repository';

// Regression of the move to the shared effects plan (phase 5 S9a): the jobs, their ids, their
// order and the report must be exactly what S10's OrderAdminEffects produced. `legacy` below is
// that code's algorithm, copied verbatim in shape, used as the oracle. Synthetic ids only.

type Step =
  | { readonly op: 'invalidate'; readonly userId: string }
  | { readonly op: 'add'; readonly id: string };

type LegacyEffects = ResolvedEffects & { readonly userId: string };

function legacy(
  e: LegacyEffects,
  failing: ReadonlySet<string>,
): {
  readonly steps: Step[];
  readonly report: EffectsReport;
} {
  const steps: Step[] = [];
  const add = (job: NotifyJob): boolean => {
    const id = notifyJobId(notifyJobSchema.parse(job));
    steps.push({ op: 'add', id });
    return !failing.has(id);
  };
  const alert = (name: 'tonWalletCompromised' | 'reviewResolved' | 'adminAction', refId: string) =>
    add({ kind: 'OWNER_ALERT', alert: name, refId });
  if (e.refunded) steps.push({ op: 'invalidate', userId: e.userId });
  const kind = e.to === 'DELIVERED' ? 'ORDER_DELIVERED' : 'ORDER_REFUNDED';
  const customerNotified =
    e.to === 'DELIVERED' || e.refunded ? add({ kind, refId: e.orderId }) : false;
  const securityAlert =
    e.compromisedTransferId === null
      ? null
      : alert('tonWalletCompromised', e.compromisedTransferId);
  const reviewResolved = alert('reviewResolved', `${e.orderId}_${e.auditId}`);
  const adminAction = alert('adminAction', e.auditId);
  return { steps, report: { customerNotified, adminAction, reviewResolved, securityAlert } };
}

function harness(failing: ReadonlySet<string> = new Set()) {
  const steps: Step[] = [];
  const names: string[] = [];
  const cache = {
    invalidate: jest.fn((userId: string) => {
      steps.push({ op: 'invalidate', userId });
      return Promise.resolve();
    }),
  };
  const queue = {
    add: jest.fn((name: string, _job: unknown, opts: { jobId: string }) => {
      names.push(name);
      steps.push({ op: 'add', id: opts.jobId });
      return failing.has(opts.jobId) ? Promise.reject(new Error('redis down')) : Promise.resolve();
    }),
  };
  const effects = new OrderAdminEffects(
    cache as unknown as WalletCache,
    {} as unknown as FulfillOrderEnqueuer,
    queue as unknown as Queue,
  );
  return { effects, steps, names };
}

const BASE = {
  orderId: 'cmorder1abc',
  userId: 'cmuser1abc',
  auditId: 'cmaudit1abc',
} as const;

const CASES: LegacyEffects[] = (['DELIVERED', 'FAILED'] as const).flatMap((to) =>
  [false, true].flatMap((refunded) =>
    [null, 'cmtransfer1abc'].map((compromisedTransferId) => ({
      ...BASE,
      to,
      refunded,
      compromisedTransferId,
    })),
  ),
);

describe('OrderAdminEffects on the shared plan (S9a regression)', () => {
  it.each(CASES)('afterResolve %j: same steps, ids, order and report as S10', async (e) => {
    const h = harness();
    const report = await h.effects.afterResolve(e);
    const expected = legacy(e, new Set());
    expect(h.steps).toEqual(expected.steps);
    expect(report).toEqual(expected.report);
    expect(new Set(h.names)).toEqual(new Set([NOTIFY_JOB_NAME]));
  });

  it.each(CASES)(
    'afterResolve %j: a failed add is reported false, the rest still go',
    async (e) => {
      const all = legacy(e, new Set()).steps.flatMap((s) => (s.op === 'add' ? [s.id] : []));
      for (const id of all) {
        const failing = new Set([id]);
        const h = harness(failing);
        const report = await h.effects.afterResolve(e);
        const expected = legacy(e, failing);
        expect(h.steps).toEqual(expected.steps);
        expect(report).toEqual(expected.report);
      }
    },
  );

  it('L-4: a refund with no known owner deletes no wallet key, the notices still go', async () => {
    const h = harness();
    const e: ResolvedEffects = {
      ...BASE,
      userId: null,
      to: 'FAILED',
      refunded: true,
      compromisedTransferId: null,
    };
    const report = await h.effects.afterResolve(e);
    expect(h.steps).toEqual([
      { op: 'add', id: `order-${BASE.orderId}-refunded` },
      { op: 'add', id: `alert-reviewResolved-${BASE.orderId}_${BASE.auditId}` },
      { op: 'add', id: `alert-adminAction-${BASE.auditId}` },
    ]);
    expect(report).toEqual({
      customerNotified: true,
      adminAction: true,
      reviewResolved: true,
      securityAlert: null,
    });
  });

  it('adminAction(auditId): one adminAction job, the same id as before', async () => {
    const h = harness();
    await expect(h.effects.adminAction('cmaudit2abc')).resolves.toBe(true);
    expect(h.steps).toEqual([{ op: 'add', id: 'alert-adminAction-cmaudit2abc' }]);
    const down = harness(new Set(['alert-adminAction-cmaudit2abc']));
    await expect(down.effects.adminAction('cmaudit2abc')).resolves.toBe(false);
  });

  it('an id that cannot be a job id still throws (as S10 did), nothing is queued for it', async () => {
    const h = harness();
    await expect(h.effects.adminAction('bad:id')).rejects.toThrow();
    expect(h.steps).toEqual([]);
  });

  it('the API action names are the ones the shared plan knows (one source for S9h)', () => {
    expect(REVIEW_RESOLVE_ACTION).toBe(ORDER_EFFECTS_ACTIONS.reviewResolve);
    expect(ORDER_RETRY_ACTION).toBe(ORDER_EFFECTS_ACTIONS.retry);
    expect(FX_SET_ACTION).toBe(ORDER_EFFECTS_ACTIONS.fxSet);
  });

  it('the audit row the API writes replays to the same jobs (fresh resolve vs worker sweep)', async () => {
    const e: ResolvedEffects = {
      ...BASE,
      to: 'FAILED',
      refunded: true,
      compromisedTransferId: 'cmtransfer1abc',
    };
    const h = harness();
    await h.effects.afterResolve(e);
    const fromRow = orderEffectsPlan(
      {
        id: BASE.auditId,
        action: REVIEW_RESOLVE_ACTION,
        targetType: 'Order',
        targetId: BASE.orderId,
        actorType: 'CLI',
        after: {
          proof: {
            kind: 'TON_UNMATCHED_RESOLVED',
            finding: 'SENT_ELSEWHERE',
            transferId: 'cmtransfer1abc',
          },
          refund: { amountTiyin: '100', ledgerEntryId: 'cmledger1abc' },
        },
      },
      { id: BASE.orderId, userId: BASE.userId, status: 'REFUNDED' },
    );
    const replayed: Step[] = [
      ...(fromRow.invalidateWalletOf === null
        ? []
        : [{ op: 'invalidate' as const, userId: fromRow.invalidateWalletOf }]),
      ...fromRow.notifyJobs.map((job) => ({ op: 'add' as const, id: notifyJobId(job) })),
    ];
    expect(replayed).toEqual(h.steps);
  });

  it('a retry audit row plans the API retry effects: adminAction and the requeue', () => {
    const plan = orderEffectsPlan(
      {
        id: 'cmaudit3abc',
        action: ORDER_RETRY_ACTION,
        targetType: 'Order',
        targetId: BASE.orderId,
        actorType: 'CLI',
        after: {},
      },
      { id: BASE.orderId, userId: BASE.userId, status: 'QUEUED' },
    );
    expect(plan.notifyJobs.map((job) => notifyJobId(job))).toEqual([
      'alert-adminAction-cmaudit3abc',
    ]);
    expect(plan.requeueOrderId).toBe(BASE.orderId);
  });
});
