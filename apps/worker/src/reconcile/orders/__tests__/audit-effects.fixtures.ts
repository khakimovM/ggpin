import { notifyJobId, type EffectsOrder, type JobStateName, type NotifyJob } from '@repo/shared';
import type { WalletCacheInvalidator } from '../../../bank-feed/wallet-cache-invalidator';
import type { AbandonPeek } from '../../../fulfillment/abandon-counter';
import type { FulfillEnqueuer } from '../../../fulfillment/fulfill-enqueuer';
import { OrderLockUnavailableError, type LockedRun } from '../../../fulfillment/order-lock';
import type {
  AuditCursor,
  AuditEffectsRepository,
  AuditEffectsRow,
} from '../audit-effects.repository';
import { AuditEffectsStep } from '../audit-effects.step';
import { ReconcileNotifier } from '../reconcile-notifier';
import type { ReconcileOrderLock } from '../reconcile-order-lock';

// The audit-effects step's unit stand-ins: the real ReconcileNotifier over a fake queue that keeps
// BullMQ's one-job-per-id rule, a fake order lock that records when it is held, and an abandon
// reader that answers a fixed count or a sequence (one value per read, the last one repeating).

export const NOW = 1_790_000_000_000;
export const ORDER = 'cmorder00000000000000000a';
export const USER = 'cmuser000000000000000000a';
export const AUDIT = 'cmaudit0000000000000000a';
export const TRANSFER = 'cmtransfer000000000000000a';

export function row(over: Partial<AuditEffectsRow> = {}): AuditEffectsRow {
  return {
    id: AUDIT,
    action: 'ORDER_REVIEW_RESOLVE',
    targetType: 'Order',
    targetId: ORDER,
    actorType: 'CLI',
    after: { refund: { amountTiyin: '500', ledgerEntryId: 'x' }, proof: { kind: 'MANUAL' } },
    createdAt: new Date(NOW - 3_600_000),
    ...over,
  };
}

export interface Setup {
  readonly page?: AuditEffectsRow[];
  readonly order?: Partial<EffectsOrder> | null;
  readonly status?: string;
  readonly state?: JobStateName;
  readonly abandoned?: number | readonly number[];
  readonly busy?: boolean;
  readonly lockDown?: boolean;
  readonly failAdd?: boolean;
}

export function build(setup: Setup = {}) {
  const order: EffectsOrder | null =
    setup.order === null ? null : { id: ORDER, userId: USER, status: 'REFUNDED', ...setup.order };
  const repository = {
    page: jest
      .fn<Promise<AuditEffectsRow[]>, [Date, Date, AuditCursor | null, number]>()
      .mockResolvedValue(setup.page ?? [row()]),
    ordersOf: jest.fn().mockResolvedValue(new Map(order === null ? [] : [[order.id, order]])),
    statusOf: jest.fn().mockResolvedValue(setup.status ?? 'QUEUED'),
  };
  const jobs = new Map<string, NotifyJob>();
  const queue = {
    add: jest.fn((_name: string, data: NotifyJob, options: { jobId: string }) => {
      if (setup.failAdd === true) return Promise.reject(new Error('redis down'));
      if (!jobs.has(options.jobId)) jobs.set(options.jobId, data);
      return Promise.resolve({});
    }),
  };
  const invalidated: string[] = [];
  const wallets = {
    invalidate: (userId: string) => {
      invalidated.push(userId);
      return Promise.resolve();
    },
  };
  const notifier = new ReconcileNotifier(queue, wallets as unknown as WalletCacheInvalidator);
  const inLock: string[] = [];
  const enqueuer = {
    stateOf: jest.fn().mockResolvedValue(setup.state ?? 'unknown'),
    enqueue: jest.fn(() => {
      // After the lease is gone: the new job must not meet our own lease.
      expect(inLock).toEqual([]);
      return Promise.resolve('add');
    }),
  };
  const peek = jest.fn<Promise<number>, [string]>();
  const counts = typeof setup.abandoned === 'object' ? setup.abandoned : [setup.abandoned ?? 0];
  for (const count of counts) peek.mockResolvedValueOnce(count);
  peek.mockResolvedValue(counts[counts.length - 1] ?? 0);
  const counter: AbandonPeek = { peek };
  const lock: ReconcileOrderLock = {
    run: async <T>(orderId: string, fn: () => Promise<T>): Promise<LockedRun<T>> => {
      if (setup.lockDown === true) throw new OrderLockUnavailableError();
      if (setup.busy === true) return { busy: true };
      inLock.push(orderId);
      const value = await fn();
      inLock.pop();
      return { busy: false, value };
    },
  };
  const step = new AuditEffectsStep(
    repository as unknown as AuditEffectsRepository,
    notifier,
    enqueuer as unknown as FulfillEnqueuer,
    counter,
    lock,
  );
  return { step, repository, jobs, queue, invalidated, enqueuer, peek };
}

export const ids = (jobs: readonly NotifyJob[]): string[] => jobs.map((job) => notifyJobId(job));
