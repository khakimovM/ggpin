import { Logger } from '@nestjs/common';
import {
  AUDIT_EFFECTS_MIN_AGE_MS,
  AUDIT_EFFECTS_WINDOW_MS,
  RECONCILE_BATCH_LIMIT,
  effectsOf,
  notifyJobId,
} from '@repo/shared';
import { heldExpiredEffects } from '../held-sweep.step';
import { AUDIT, NOW, ORDER, TRANSFER, USER, build, ids, row } from './audit-effects.fixtures';

// D-64 (9), audit I-3: the effects lost between a writer's commit and its queue are rebuilt from
// the audit row with the shared plan's ids, inside [now - 24 h, now - 2 min] only.

describe('AuditEffectsStep', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('reads [now - 24 h, now - 2 min] on the tick clock, at most one batch', async () => {
    const { step, repository } = build();
    await step.run({ nowMs: NOW });
    expect(repository.page).toHaveBeenCalledWith(
      new Date(NOW - AUDIT_EFFECTS_WINDOW_MS),
      new Date(NOW - AUDIT_EFFECTS_MIN_AGE_MS),
      null,
      RECONCILE_BATCH_LIMIT,
    );
    expect(AUDIT_EFFECTS_WINDOW_MS).toBe(24 * 3_600_000);
    expect(AUDIT_EFFECTS_MIN_AGE_MS).toBe(120_000);
  });

  it("an operator's refund: exactly the ids OrderAdminEffects.afterResolve queues, cache first", async () => {
    const { step, jobs, invalidated } = build();
    const report = await step.run({ nowMs: NOW });
    // The API's own call (order-admin-effects.ts afterResolve), facts as it knows them.
    const api = effectsOf({
      kind: 'REVIEW_RESOLVED',
      orderId: ORDER,
      auditId: AUDIT,
      userId: USER,
      delivered: false,
      refunded: true,
      compromisedTransferId: null,
      byOperator: true,
    });
    expect([...jobs.keys()]).toEqual(ids(api.notifyJobs));
    expect([...jobs.keys()]).toEqual([
      notifyJobId({ kind: 'ORDER_REFUNDED', refId: ORDER }),
      notifyJobId({ kind: 'OWNER_ALERT', alert: 'reviewResolved', refId: `${ORDER}_${AUDIT}` }),
      notifyJobId({ kind: 'OWNER_ALERT', alert: 'adminAction', refId: AUDIT }),
    ]);
    expect(invalidated).toEqual([USER]);
    expect(report.counts).toEqual({ replayed: 1 });
  });

  it("S9c SA I-3: the reconciler's (SYSTEM) refund: notice, reviewResolved, cache; no adminAction", async () => {
    const { step, jobs, invalidated } = build({ page: [row({ actorType: 'SYSTEM' })] });
    await step.run({ nowMs: NOW });
    expect([...jobs.keys()]).toEqual([
      notifyJobId({ kind: 'ORDER_REFUNDED', refId: ORDER }),
      notifyJobId({ kind: 'OWNER_ALERT', alert: 'reviewResolved', refId: `${ORDER}_${AUDIT}` }),
    ]);
    expect(invalidated).toEqual([USER]);
  });

  it('a refund notice is the very job of the HELD_EXPIRED refund (S9e): one message, not two', async () => {
    const { step, jobs } = build({ page: [row({ actorType: 'SYSTEM' })] });
    await step.run({ nowMs: NOW });
    const held = heldExpiredEffects(ORDER, USER).notifyJobs.filter((j) => j.kind !== 'OWNER_ALERT');
    expect(ids(held)).toHaveLength(1);
    expect([...jobs.keys()]).toContain(ids(held)[0]);
  });

  it('a delivery: ORDER_DELIVERED only while the order IS delivered, no cache delete', async () => {
    const delivered = row({ after: { refund: null, proof: { kind: 'MANUAL' } } });
    const a = build({ page: [delivered], order: { status: 'DELIVERED' } });
    await a.step.run({ nowMs: NOW });
    expect([...a.jobs.keys()][0]).toBe(notifyJobId({ kind: 'ORDER_DELIVERED', refId: ORDER }));
    expect(a.invalidated).toEqual([]);
    const b = build({ page: [delivered], order: { status: 'REFUNDED' } });
    await b.step.run({ nowMs: NOW });
    expect([...b.jobs.values()].map((j) => j.kind)).toEqual(['OWNER_ALERT', 'OWNER_ALERT']);
  });

  it('SENT_ELSEWHERE: tonWalletCompromised with the transfer as refId', async () => {
    const proof = {
      kind: 'TON_UNMATCHED_RESOLVED',
      finding: 'SENT_ELSEWHERE',
      transferId: TRANSFER,
    };
    const { step, jobs } = build({ page: [row({ after: { refund: null, proof } })] });
    await step.run({ nowMs: NOW });
    expect([...jobs.keys()]).toContain(
      notifyJobId({ kind: 'OWNER_ALERT', alert: 'tonWalletCompromised', refId: TRANSFER }),
    );
  });

  it.each([
    ['FX_SET', 'FxRate'],
    ['TON_TX_HINT', 'TonTransfer'],
  ])('%s: the owner hears adminAction (auditId), nothing else', async (action, targetType) => {
    const { step, jobs, invalidated, repository } = build({
      page: [row({ action, targetType, targetId: TRANSFER, after: {} })],
    });
    await step.run({ nowMs: NOW });
    expect([...jobs.keys()]).toEqual([
      notifyJobId({ kind: 'OWNER_ALERT', alert: 'adminAction', refId: AUDIT }),
    ]);
    expect(invalidated).toEqual([]);
    // Only Order targets are looked up as orders.
    expect(repository.ordersOf).toHaveBeenCalledWith([]);
  });

  it('a known action on a foreign target type plans nothing (the shared plan checks it too)', async () => {
    const { step, jobs, invalidated, enqueuer } = build({
      page: [row({ action: 'ORDER_RETRY', targetType: 'FxRate' })],
      order: { status: 'QUEUED' },
    });
    const report = await step.run({ nowMs: NOW });
    expect(jobs.size).toBe(0);
    expect(invalidated).toEqual([]);
    expect(enqueuer.enqueue).not.toHaveBeenCalled();
    expect(report.counts).toEqual({ nothing: 1 });
  });

  it('two ticks: the same ids, nothing doubled', async () => {
    const { step, jobs, queue } = build();
    await step.run({ nowMs: NOW });
    const first = [...jobs.keys()];
    await step.run({ nowMs: NOW + 600_000 });
    expect([...jobs.keys()]).toEqual(first);
    expect(queue.add.mock.calls.map((call) => call[2].jobId)).toEqual([...first, ...first]);
  });

  it('CR-6: every add lost: counted notQueued and logged, NOT replayed (tried next lap)', async () => {
    const { step } = build({ failAdd: true });
    expect((await step.run({ nowMs: NOW })).counts).toEqual({ notQueued: 3 });
  });

  it('CR-6: some adds in, one lost: replayed, and the lost one counted', async () => {
    const { step, queue } = build();
    queue.add.mockImplementationOnce(() => Promise.reject(new Error('redis down')));
    expect((await step.run({ nowMs: NOW })).counts).toEqual({ notQueued: 1, replayed: 1 });
  });

  it('one failing row does not stop the next', async () => {
    const retry = row({ action: 'ORDER_RETRY', after: { status: 'QUEUED' } });
    const other = row({ id: 'cmaudit0000000000000000b', action: 'FX_SET', targetType: 'FxRate' });
    const { step, enqueuer, jobs } = build({ page: [retry, other], order: { status: 'QUEUED' } });
    enqueuer.stateOf.mockRejectedValue(new Error('queue read failed'));
    const report = await step.run({ nowMs: NOW });
    expect(report.counts).toEqual({ failed: 1, replayed: 2 });
    expect([...jobs.keys()]).toContain(
      notifyJobId({ kind: 'OWNER_ALERT', alert: 'adminAction', refId: 'cmaudit0000000000000000b' }),
    );
  });

  it('walks the window in batches: a full page moves the cursor, a short one resets it', async () => {
    const full = Array.from({ length: RECONCILE_BATCH_LIMIT }, (_, i) =>
      row({ id: `cmaudit${String(i).padStart(17, '0')}`, action: 'FX_SET', targetType: 'FxRate' }),
    );
    const { step, repository } = build({ page: full });
    await step.run({ nowMs: NOW });
    repository.page.mockResolvedValue([]);
    await step.run({ nowMs: NOW });
    await step.run({ nowMs: NOW });
    const cursors = repository.page.mock.calls.map((call) => call[2]);
    expect(cursors).toEqual([null, full[full.length - 1], null]);
  });

  it('CR-1: a step stopped mid-page resumes at the stopping row, not after a lap', async () => {
    const fx = (i: number) =>
      row({ id: `cmaudit${String(i).padStart(17, '0')}`, action: 'FX_SET', targetType: 'FxRate' });
    const stop = row({ id: 'cmaudit00000000000000050', action: 'ORDER_RETRY', after: {} });
    for (const length of [RECONCILE_BATCH_LIMIT, 60]) {
      const page = Array.from({ length }, (_, i) => (i === 50 ? stop : fx(i)));
      const { step, repository } = build({ page, order: { status: 'QUEUED' }, lockDown: true });
      await expect(step.run({ nowMs: NOW })).rejects.toThrow();
      await expect(step.run({ nowMs: NOW })).rejects.toThrow();
      const cursors = repository.page.mock.calls.map((call) => call[2]);
      expect(cursors).toEqual([null, page[49]]);
    }
  });
});
