import { rowsOf } from '../../../ton/__tests__/ton-e2e.fixtures';
import { useTonE2e, type TonInstance } from '../../../ton/__tests__/ton-e2e.harness';
import { falselyConsumed } from '../../../ton/__tests__/ton-false-consumed.fixtures';
import {
  falseExpired,
  heldExpiredRefund,
  ledgerOf,
  liveHoldsSeqno,
} from '../../../ton/__tests__/ton-late.e2e-kit';
import type { FakeTonGateway } from '../../../ton/fake-ton.gateway';
import type { TonChainWitness } from '../../../ton/ton-gateway';
import { episodeRef } from '../guard-ref';
import type { LateFactsStep } from '../late-facts.step';
import type { StepReport } from '../reconcile-step';
import { lateStepOf, ownerHintRow } from './late-facts.e2e-kit';

// The late-facts step (S9f) on the real database, built from a booted TON module's providers (its
// place in RECONCILE_STEPS is the coordinator's wiring, s9f-wiring.md). Each test has a wallet of
// its own, so the step's lists (scoped to the worker's hot wallet) see this test's rows only.
// Mainnet gate I-4: the EXPIRED transfer of a HELD_EXPIRED -> REFUNDED order is watched too.

const t = useTonE2e();

const stepOf = (
  witnesses: readonly TonChainWitness[] = [],
  instance: TonInstance = t.ton,
  gateway: FakeTonGateway = t.gateway,
): LateFactsStep => lateStepOf(t, witnesses, instance, gateway);

const tick = (step: LateFactsStep): Promise<StepReport> => step.run({ nowMs: Date.now() });

const hintRow = (
  transferId: string,
  ref: { txHash: string; lt: string },
  actorType: string,
  actor?: Record<string, string> | null,
) => ownerHintRow(t, transferId, ref, actorType, actor);

describe('LateFactsStep (S9f)', () => {
  it('I-4: the EXPIRED transfer of a REFUNDED order is found, then its late bounce; money unmoved', async () => {
    const fixture = await t.order();
    const { transferId } = await falseExpired(t.db, t.gateway, t.ton, fixture, 'BOUNCE');
    await heldExpiredRefund(t.db, fixture);
    const refunded = await ledgerOf(t.db, fixture.userId);
    const step = stepOf();
    expect((await tick(step)).counts).toEqual({ LATE_BOUNCE: 1, LATE_CONFIRMED: 1 });
    const rows = await rowsOf(t.db, fixture);
    expect(rows.transfer?.status).toBe('CONFIRMED');
    expect(rows.attempt.response).toMatchObject({
      ton: { late: { from: 'EXPIRED' }, lateBounce: { orderStatus: 'REFUNDED' } },
    });
    expect(rows.order.status).toBe('REFUNDED');
    expect(await ledgerOf(t.db, fixture.userId)).toEqual(refunded);
    // The next tick only queues the two alerts again (same ids): nothing is looked at or written.
    await t.dropJobs([{ kind: 'ALERT', alert: 'tonBounced', refId: transferId }]);
    expect((await tick(step)).counts).toEqual({});
    await t.expectJobs([
      { kind: 'ALERT', alert: 'tonLateConfirmed', refId: transferId },
      { kind: 'ALERT', alert: 'tonBounced', refId: transferId },
    ]);
  });

  it('the hint of the owner CLI channel only; checked once per hint', async () => {
    const { fixture, gateway, fork, ton, transferId, ref } = await falselyConsumed(t);
    const step = stepOf([gateway.freshConnection()], ton, gateway);
    // The fork hides our transaction again while the rows below are not the owner's.
    gateway.fork = fork;
    await hintRow(transferId, ref, 'ADMIN');
    // Not an owner hint; the late scan does not find the lost message either.
    expect((await tick(step)).counts).toEqual({ 'nothing:NOT_FOUND': 1 });
    // A CLI row without the owner actor in `after` (review F6) is not one either.
    await hintRow(transferId, ref, 'CLI', null);
    expect((await tick(step)).counts).toEqual({ 'nothing:NOT_FOUND': 1 });
    await hintRow(transferId, ref, 'CLI', { type: 'CLI', role: 'OPERATOR' });
    expect((await tick(step)).counts).toEqual({ 'nothing:NOT_FOUND': 1 });
    expect((await rowsOf(t.db, fixture)).transfer?.status).toBe('CONSUMED_UNMATCHED');
    gateway.fork = null;
    const audit = await hintRow(transferId, ref, 'CLI');
    // Accepted, and in the same tick the CONFIRMED transfer is a processed payout.
    expect((await tick(step)).counts).toEqual({ HINT_ACCEPTED: 1, 'nothing:PROCESSED': 1 });
    const rows = await rowsOf(t.db, fixture);
    expect(rows.transfer).toMatchObject({ status: 'CONFIRMED', txHash: ref.txHash });
    expect(rows.attempt.response).toMatchObject({
      ton: { hint: { auditId: audit.id, verdict: 'ACCEPTED' } },
    });
    expect(rows.order.status).toBe('NEEDS_REVIEW');
    // The hint list is empty now; the bounce watch of this process ended.
    expect((await tick(step)).counts).toEqual({ 'nothing:SETTLED': 1 });
  });

  it('a refused write raises reconcileGuardRefused (never silent) and tonLateConfirmed', async () => {
    const { fixture, firstId } = await liveHoldsSeqno(t);
    const step = stepOf();
    const nowMs = Date.now();
    const report = await step.run({ nowMs });
    expect(report.counts).toMatchObject({ guardRefused: 1 });
    expect((await rowsOf(t.db, fixture)).transfer?.status).toBe('EXPIRED');
    const ref = episodeRef(fixture.orderId, 'ton', nowMs) ?? '';
    await t.expectJobs([
      { kind: 'ALERT', alert: 'reconcileGuardRefused', refId: ref },
      { kind: 'ALERT', alert: 'tonLateConfirmed', refId: firstId },
    ]);
    // F3: the refusal is kept as a SEQNO_HELD fact; the next tick does not refuse (or alert) again.
    await t.dropJobs([{ kind: 'ALERT', alert: 'reconcileGuardRefused', refId: ref }]);
    const again = await step.run({ nowMs });
    expect(again.counts['guardRefused']).toBeUndefined();
    await t.expectNoJob({ kind: 'ALERT', alert: 'reconcileGuardRefused', refId: ref });
  });

  it('an aborted destination: the lateDestination fact and the hourly reconcileGuardRefused, never silenced', async () => {
    const fixture = await t.order();
    const { transferId } = await falseExpired(t.db, t.gateway, t.ton, fixture, 'ABORT_NO_BOUNCE');
    const step = stepOf();
    const nowMs = Date.now();
    expect((await step.run({ nowMs })).counts).toEqual({
      LATE_CONFIRMED: 1,
      LATE_DESTINATION: 1,
    });
    const ref = episodeRef(fixture.orderId, 'ton', nowMs) ?? '';
    await t.expectJobs([
      { kind: 'ALERT', alert: 'tonLateConfirmed', refId: transferId },
      { kind: 'ALERT', alert: 'reconcileGuardRefused', refId: ref },
    ]);
    // Next tick (a new process too): nothing is looked at; the alert is queued again from the fact.
    await t.dropJobs([{ kind: 'ALERT', alert: 'reconcileGuardRefused', refId: ref }]);
    expect((await stepOf().run({ nowMs })).counts).toEqual({});
    await t.expectJobs([{ kind: 'ALERT', alert: 'reconcileGuardRefused', refId: ref }]);
    // The next hour is a new episode: heard again.
    const later = nowMs + 3_600_000;
    await stepOf().run({ nowMs: later });
    const next = episodeRef(fixture.orderId, 'ton', later) ?? '';
    expect(next).not.toBe(ref);
    await t.expectJobs([{ kind: 'ALERT', alert: 'reconcileGuardRefused', refId: next }]);
  });
});
