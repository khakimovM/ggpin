import { getQueueToken } from '@nestjs/bullmq';
import { QUEUES } from '@repo/shared';
import type { Queue } from 'bullmq';
import { RedisLockStore } from '../../../bank-feed/client/leader-lock';
import { WalletCacheInvalidator } from '../../../bank-feed/wallet-cache-invalidator';
import { OrderLock } from '../../../fulfillment/order-lock';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RedisService } from '../../../infra/redis/redis.service';
import type { TonE2e, TonInstance } from '../../../ton/__tests__/ton-e2e.harness';
import { lateServiceOf } from '../../../ton/__tests__/ton-late.e2e-kit';
import type { FakeTonGateway } from '../../../ton/fake-ton.gateway';
import type { TonChainWitness } from '../../../ton/ton-gateway';
import { TON_HOT_WALLET_ADDRESS, type TonHotWalletAddress } from '../../../ton/ton-tokens';
import { LateFactsRepository } from '../late-facts.repository';
import { LateFactsStep } from '../late-facts.step';
import { ReconcileNotifier } from '../reconcile-notifier';

// The late-facts step (S9f) on the real database, built from a booted TON module's providers (its
// place in RECONCILE_STEPS is the coordinator's wiring), and the owner hint rows it reads.

export function lateStepOf(
  t: TonE2e,
  witnesses: readonly TonChainWitness[] = [],
  instance: TonInstance = t.ton,
  gateway: FakeTonGateway = t.gateway,
): LateFactsStep {
  const m = instance.moduleRef;
  const redis = m.get(RedisService);
  return new LateFactsStep(
    new LateFactsRepository(m.get(PrismaService)),
    lateServiceOf(m, gateway, witnesses),
    new ReconcileNotifier(m.get(getQueueToken(QUEUES.NOTIFY)), new WalletCacheInvalidator(redis)),
    new OrderLock(new RedisLockStore(redis.client), 60_000),
    m.get<symbol, TonHotWalletAddress>(TON_HOT_WALLET_ADDRESS),
  );
}

/** The `after.actor` the owner CLI channel writes (CLI_OWNER_AUDIT_ACTOR). */
export const OWNER_ACTOR = { type: 'CLI', role: 'OWNER' };

/** An owner hint as `ton:hint` writes it (AuditLog TON_TX_HINT), or as another channel would. */
export function ownerHintRow(
  t: TonE2e,
  transferId: string,
  ref: { txHash: string; lt: string },
  actorType: string,
  actor: Record<string, string> | null = OWNER_ACTOR,
) {
  return t.db.auditLog.create({
    data: {
      actorType,
      actorId: null,
      action: 'TON_TX_HINT',
      targetType: 'TonTransfer',
      targetId: transferId,
      before: { status: 'CONSUMED_UNMATCHED' },
      after: { ...ref, operator: 'late-facts-e2e', ...(actor === null ? {} : { actor }) },
      reason: 'found in the wallet history by hand (e2e)',
      ip: null,
    },
    select: { id: true },
  });
}

/**
 * The first `add` of the notify job `jobId` fails (Redis away right after the commit), unless
 * `failFirst` is false; every add of it is counted, so a test sees each re-queue, not only the one
 * job BullMQ keeps.
 */
export function failFirstAdd(t: TonE2e, jobId: string, failFirst = true) {
  const queue = t.ton.moduleRef.get<string, Queue>(getQueueToken(QUEUES.NOTIFY));
  const add = queue.add.bind(queue);
  let adds = 0;
  const spy = jest.spyOn(queue, 'add').mockImplementation((name, data, options) => {
    if (options?.jobId !== jobId) return add(name, data, options);
    adds += 1;
    if (failFirst && adds === 1) return Promise.reject(new Error('redis away (e2e)'));
    return add(name, data, options);
  });
  return { adds: (): number => adds, restore: (): void => spy.mockRestore() };
}
