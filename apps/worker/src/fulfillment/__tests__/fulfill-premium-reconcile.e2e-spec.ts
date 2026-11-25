import { Test } from '@nestjs/testing';
import { SIMULATED_FRAGMENT_PAY_ADDRESS } from '../../adapters/simulator/simulator-script';
import { WorkerConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../infra/prisma/prisma.module';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { QueueModule } from '../../infra/queue/queue.module';
import { RedisModule } from '../../infra/redis/redis.module';
import { ScopedAuditEffects } from '../../reconcile/orders/__tests__/audit-effects.e2e-kit';
import {
  ReconcilerTraps,
  ScopedHeldSources,
  ScopedReconcileRepository,
  ScopedSweepsRepository,
} from '../../reconcile/orders/__tests__/reconcile-e2e.fakes';
import { AuditEffectsRepository } from '../../reconcile/orders/audit-effects.repository';
import { HeldSourcesRepository } from '../../reconcile/orders/held-sources.repository';
import { OrderReconcileModule } from '../../reconcile/orders/order-reconcile.module';
import { OrderReconcileProcessor } from '../../reconcile/orders/order-reconcile.processor';
import { OrderReconcileRepository } from '../../reconcile/orders/order-reconcile.repository';
import { OrderReconcileScheduler } from '../../reconcile/orders/order-reconcile.scheduler';
import {
  OrderReconcileService,
  type TickReport,
} from '../../reconcile/orders/order-reconcile.service';
import { OrderSweepsRepository } from '../../reconcile/orders/order-sweeps.repository';
import { TEST_TIMING, TestSenderHooks, pinChain } from '../../ton/__tests__/ton-e2e.harness';
import { overrideTon } from '../../ton/__tests__/ton-overrides';
import { TonSenderService } from '../../ton/ton-sender.service';
import { FulfillOrderProcessor } from '../fulfill-order.processor';
import { attemptsOf, ledgerOf, orderRow, transfersOf } from './fulfill-e2e.fixtures';
import { useFulfillE2e } from './fulfill-e2e.harness';
import { PREMIUM_NANO, premiumOrder } from './premium-e2e.fixtures';

// Phase 6 S2 / plan §5.1: the order reconciler (p5 S9) is product-agnostic, proven here by ONE
// test: a Premium order paid by the real fulfill run times out (NEEDS_REVIEW, transfer BROADCAST),
// its TON message lands later, and ONE reconciler tick delivers it exactly as it does a Stars
// order (order-reconcile-transfers.e2e-spec.ts): transfer CONFIRMED, DELIVERED by TON_TX, the
// PURCHASE alone in the ledger, nothing signed or sent by the reconciler (trap sender and lock).
// The reconciler's lists are scoped to this order, as in reconcile-e2e.harness.ts.

const t = useFulfillE2e();

function countsOf(report: TickReport, step: string): Readonly<Record<string, number>> {
  return report.steps.find((s) => s.step === step)?.counts ?? {};
}

async function bootReconciler(orders: ReadonlySet<string>, traps: ReconcilerTraps) {
  const builder = overrideTon(
    Test.createTestingModule({
      imports: [
        WorkerConfigModule.forRoot(t.env),
        PrismaModule,
        RedisModule,
        QueueModule,
        OrderReconcileModule,
      ],
    }),
    {
      wallet: t.wallet,
      gateway: t.gateway,
      timing: { ...TEST_TIMING, confirmTimeoutMs: 1_000 },
      hooks: new TestSenderHooks(),
      walletLock: traps.walletLock(),
      payAddresses: new Set([SIMULATED_FRAGMENT_PAY_ADDRESS]),
    },
  )
    .overrideProvider(TonSenderService)
    .useValue(traps.sender())
    .overrideProvider(OrderReconcileProcessor)
    .useValue({})
    .overrideProvider(OrderReconcileScheduler)
    .useValue({})
    .overrideProvider(FulfillOrderProcessor)
    .useValue({})
    .overrideProvider(OrderReconcileRepository)
    .useFactory({
      factory: (prisma: PrismaService) => new ScopedReconcileRepository(prisma, orders),
      inject: [PrismaService],
    })
    .overrideProvider(OrderSweepsRepository)
    .useFactory({
      factory: (prisma: PrismaService) => new ScopedSweepsRepository(prisma, orders),
      inject: [PrismaService],
    })
    .overrideProvider(HeldSourcesRepository)
    .useFactory({
      factory: (prisma: PrismaService) => new ScopedHeldSources(prisma, orders),
      inject: [PrismaService],
    })
    .overrideProvider(AuditEffectsRepository)
    .useFactory({
      factory: (prisma: PrismaService) => new ScopedAuditEffects(prisma, orders),
      inject: [PrismaService],
    });
  const moduleRef = await builder.compile();
  moduleRef.useLogger(false);
  await moduleRef.init();
  return moduleRef;
}

describe('order reconciler: a Telegram Premium payout is resolved like a Stars one', () => {
  it('a timed-out 6-month payout lands later: one tick, transfer CONFIRMED, order DELIVERED', async () => {
    pinChain(t.gateway, 0);
    const worker = await t.boot({ timing: { confirmTimeoutMs: 1_000 } });
    const fixture = await premiumOrder(t.db, 6);
    t.track(fixture.orderId);
    t.gateway.nextSend('HOLD');
    await expect(worker.service.run(fixture.orderId, { finalAttempt: false })).resolves.toBe(
      'DONE',
    );
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'NEEDS_REVIEW', statusReason: 'CONFIRM_TIMEOUT' }),
    );
    expect((await transfersOf(t.db, fixture.orderId)).map((x) => x.status)).toEqual(['BROADCAST']);
    t.gateway.releaseHeld();

    const traps = new ReconcilerTraps();
    const moduleRef = await bootReconciler(new Set([fixture.orderId]), traps);
    try {
      const report = await moduleRef.get(OrderReconcileService).tick();
      expect(countsOf(report, 'transfers')).toEqual({ confirmed: 1 });
      expect(countsOf(report, 'review')).toEqual({ delivered: 1 });
    } finally {
      await moduleRef.close();
    }

    const order = await orderRow(t.db, fixture.orderId);
    expect(order.status).toBe('DELIVERED');
    expect(order.deliveredAt).not.toBeNull();
    expect(await ledgerOf(t.db, fixture.orderId)).toEqual([
      { kind: 'PURCHASE', amountTiyin: -fixture.priceTiyin },
    ]);
    const audits = await t.db.auditLog.findMany({
      where: { action: 'ORDER_REVIEW_RESOLVE', targetType: 'Order', targetId: fixture.orderId },
      select: { actorType: true, after: true },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: 'SYSTEM',
      after: { resolver: 'reconciler', proof: { kind: 'TON_TX' } },
    });
    expect((await attemptsOf(t.db, fixture.orderId)).map((a) => a.status)).toEqual(['CONFIRMED']);
    const transfers = await transfersOf(t.db, fixture.orderId);
    expect(transfers.map((x) => [x.status, x.amountNanoTon])).toEqual([
      ['CONFIRMED', PREMIUM_NANO[6]],
    ]);
    expect(await t.hasJob({ kind: 'ORDER_DELIVERED', refId: fixture.orderId })).toBe(true);
    expect(t.executedOnChain()).toBe(1);
    expect(t.gateway.callCount('sendBoc')).toBe(1);
    expect(traps.calls()).toEqual({ pay: 0, walletLock: 0 });
  });
});
