import { AppError } from '../../../common/exceptions/app-error';
import type { FixedWindowCounter } from '../../../infra/redis/fixed-window-counter';
import type { OrderEffects } from '../order-effects';
import { orderRequestHash } from '../order-request-hash';
import type {
  OrderDetailView,
  OrderView,
  OrdersRepository,
  PurchaseGate,
  QuoteForOrder,
  StoredOrder,
} from '../orders.repository';
import { OrdersService } from '../orders.service';

export const NOW = new Date('2026-11-13T10:00:00.000Z');
/** An Idempotency-Key header value (8-128 of A-Z a-z 0-9 _ -). */
export const IDEM = 'idem-aaaa-0001';
export const BODY = { quoteId: 'q1' } as const;
export const HASH = orderRequestHash(BODY);
/** Stands for the transaction client: the fakes check they were handed THIS object. */
export const TX = { tx: 'purchase' };

export function quoteRow(over: Partial<QuoteForOrder> = {}): QuoteForOrder {
  return {
    id: 'q1',
    userId: 'u1',
    productId: 'p1',
    skuId: 's50',
    quantity: 50,
    recipient: { username: 'aziz_k', displayName: 'Aziz' },
    providerRef: 'ref_777',
    costCurrency: 'TON',
    costMinor: 125_000_000n,
    maxCostMinor: 128_750_000n,
    fxRateId: 'fx_1',
    priceTiyin: 550_000n,
    discountCodeId: null,
    expiresAt: new Date(NOW.getTime() + 600_000),
    usedAt: null,
    order: null,
    product: { deliveryType: 'TG_USERNAME' },
    ...over,
  };
}

export function orderRow(over: Partial<OrderView> = {}): OrderView {
  return {
    id: 'o1',
    number: 1042,
    status: 'PAID',
    productId: 'p1',
    skuId: 's50',
    quantity: 50,
    recipient: { username: 'aziz_k', displayName: 'Aziz' },
    priceTiyin: 550_000n,
    discountTiyin: 0n,
    createdAt: NOW,
    deliveredAt: null,
    product: { slug: 'telegram-stars', nameUz: 'Telegram Stars uz', nameRu: 'Telegram Stars ru' },
    ...over,
  };
}

export function storedRow(over: Partial<StoredOrder> = {}): StoredOrder {
  return { ...orderRow(), requestHash: HASH, ...over };
}

export function detailRow(over: Partial<OrderDetailView> = {}): OrderDetailView {
  return { ...orderRow(), events: [{ from: null, to: 'PAID', createdAt: NOW }], ...over };
}

export interface SetupOptions {
  /** What findByKey answers inside the transaction (then, after a lost race, without it). */
  readonly stored?: StoredOrder | null;
  readonly storedAfterRace?: StoredOrder | null;
  readonly quote?: QuoteForOrder | null;
  /** The account flags read under the lock (default: neither); null: no user row. */
  readonly gate?: Partial<PurchaseGate> | null;
  /** What createPaid writes (default: orderRow()). */
  readonly created?: OrderView;
  readonly balance?: bigint;
  readonly marked?: boolean;
  /** Thrown by createPaid (a unique index that lost a race). */
  readonly insertError?: Error;
  readonly orderIdByQuote?: string | null;
  readonly hitCount?: number;
  readonly now?: Date;
}

export function setup(options: SetupOptions = {}) {
  const calls: string[] = [];
  const step =
    <T>(name: string, value: T) =>
    (): Promise<T> => {
      calls.push(name);
      return Promise.resolve(value);
    };
  const counter = {
    hit: jest.fn(() => {
      calls.push('limit');
      return Promise.resolve({ count: options.hitCount ?? 1, ttlSec: 42 });
    }),
  };
  const repository = {
    transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      calls.push('begin');
      try {
        const result = await fn(TX);
        calls.push('commit');
        return result;
      } catch (error) {
        calls.push('rollback');
        throw error;
      }
    }),
    lockWallet: jest.fn(step('lock', undefined)),
    findByKey: jest.fn((_userId: string, _key: string, db?: unknown) => {
      calls.push(db === TX ? 'replay' : 'replay-after-race');
      const found = db === TX ? options.stored : options.storedAfterRace;
      return Promise.resolve(found ?? null);
    }),
    findOwnQuote: jest.fn(step('quote', options.quote === undefined ? quoteRow() : options.quote)),
    purchaseGate: jest.fn(
      step<PurchaseGate | null>(
        'gate',
        options.gate === null
          ? null
          : { isBlocked: false, purchaseFrozen: false, ...(options.gate ?? {}) },
      ),
    ),
    balance: jest.fn(step('balance', options.balance ?? 1_000_000n)),
    createPaid: jest.fn(() => {
      calls.push('insert');
      return options.insertError
        ? Promise.reject(options.insertError)
        : Promise.resolve(options.created ?? orderRow());
    }),
    appendPurchase: jest.fn(step('ledger', { id: 'le1' })),
    markQuoteUsed: jest.fn(step('used', options.marked ?? true)),
    findOwnOrderIdByQuote: jest.fn(step('order-by-quote', options.orderIdByQuote ?? null)),
    listOwn: jest.fn(step('list', { rows: [orderRow()], total: 1 })),
    findOwnDetail: jest.fn(step<OrderDetailView | null>('detail', detailRow())),
  };
  const effects = {
    afterPurchase: jest.fn(() => {
      calls.push('effects');
      return Promise.resolve();
    }),
  };
  const now = options.now ?? NOW;
  const service = new OrdersService(
    repository as unknown as OrdersRepository,
    effects as unknown as OrderEffects,
    counter as unknown as FixedWindowCounter,
    { now: () => now },
  );
  return { service, calls, counter, repository, effects };
}

/** Prisma 7 + pg adapter shape of a unique violation (recorded in payments/db-errors.ts). */
export function uniqueViolation(index: string): Error {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: { driverAdapterError: { cause: { constraint: { index } } } },
  });
}

export async function failure(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error('expected an AppError');
  return error;
}
