import { AppError } from '../../../common/exceptions/app-error';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import type { CardPoolRepository, CardTotals, CardTotalsQuery } from '../card-pool.repository';
import { CardPoolService, IntentInsertRace, type AllocationRequest } from '../card-pool.service';
import type {
  IntentWithCard,
  NewIntentData,
  TopupIntentsRepository,
} from '../topup-intents.repository';
import { totals } from './payments.fixtures';

const NOW = new Date('2026-11-05T10:00:00.000Z');
const TX = { tx: true };

const exclusion = {
  code: 'P2039',
  meta: {
    driverAdapterError: {
      cause: {
        originalCode: '23P01',
        originalMessage:
          'conflicting key value violates exclusion constraint "PaymentIntent_card_amount_reserved_excl"',
      },
    },
  },
};
const unique = (index: string) => ({
  code: 'P2002',
  meta: { driverAdapterError: { cause: { originalCode: '23505', constraint: { index } } } },
});

function setup(cards: CardTotals[], sticky: string | null = null) {
  const events: string[] = [];
  const inserted: NewIntentData[] = [];
  const repo = {
    client: { client: true },
    transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(TX)),
    boundLockWait: jest.fn((): Promise<void> => {
      events.push('lockTimeout');
      return Promise.resolve();
    }),
    lockCard: jest.fn((_tx: unknown, cardId: string): Promise<void> => {
      events.push(`lock:${cardId}`);
      return Promise.resolve();
    }),
    cardTotals: jest.fn((_db: unknown, query: CardTotalsQuery) =>
      Promise.resolve(
        cards.filter(
          (t) =>
            (query.cardId === undefined || t.card.id === query.cardId) &&
            (query.bank === undefined || t.card.bank === query.bank),
        ),
      ),
    ),
    amountUsage: jest.fn((): Promise<{ amountTiyin: bigint; lastReservedUntil: Date }[]> =>
      Promise.resolve([]),
    ),
    lastCardIdOf: jest.fn(() => Promise.resolve(sticky)),
  };
  const intents = {
    insert: jest.fn((_tx: unknown, data: NewIntentData): Promise<IntentWithCard> => {
      events.push(`insert:${data.cardId}`);
      inserted.push(data);
      return Promise.resolve({ id: 'intent_1' } as unknown as IntentWithCard);
    }),
  };
  const service = new CardPoolService(
    repo as unknown as CardPoolRepository,
    intents as unknown as TopupIntentsRepository,
    buildTestEnv({ TOPUP_SUFFIX_MAX_SOM: '3' }),
    () => 0,
  );
  return { service, repo, intents, events, inserted };
}

const request = (overrides: Partial<AllocationRequest> = {}): AllocationRequest => ({
  userId: 'u1',
  baseTiyin: 2_000_000n,
  now: NOW,
  idempotencyKey: 'key-00000001',
  requestHash: 'h',
  hashFor: () => 'x',
  ...overrides,
});

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe('CardPoolService.allocate (docs/05 §3)', () => {
  it('reads only ACTIVE cards with auto-credit on, re-reads the card under its lock, and pins reservedUntil = expiresAt + grace', async () => {
    const { service, repo, inserted } = setup([totals({ id: 'c1' })]);
    await service.allocate(request());
    const [first, underLock] = repo.cardTotals.mock.calls.map(([, query]) => query);
    expect(first).toMatchObject({ statuses: ['ACTIVE'], autoCreditOnly: true });
    expect(underLock).toMatchObject({ statuses: ['ACTIVE'], autoCreditOnly: true, cardId: 'c1' });
    const [data] = inserted;
    expect(data?.expiresAt.toISOString()).toBe('2026-11-05T10:30:00.000Z');
    expect(data?.reservedUntil.toISOString()).toBe('2026-11-06T10:30:00.000Z');
    expect(data?.amountTiyin).toBeGreaterThan(2_000_000n);
    expect(data?.amountTiyin).toBeLessThanOrEqual(2_000_300n);
  });

  it('the sticky card goes first; one lock per transaction, the next card only after the first is given up', async () => {
    const { service, repo, events } = setup(
      [totals({ id: 'c1', receiveLimitTiyin: 9_000_000_000n }), totals({ id: 'c2' })],
      'c2',
    );
    // c2 has every amount reserved: the allocator moves to c1 in a new transaction.
    repo.amountUsage.mockResolvedValueOnce(
      [1n, 2n, 3n].map((s) => ({
        amountTiyin: 2_000_000n + s * 100n,
        lastReservedUntil: new Date(NOW.getTime() + 60_000),
      })),
    );
    await service.allocate(request());
    expect(events).toEqual(['lockTimeout', 'lock:c2', 'lockTimeout', 'lock:c1', 'insert:c1']);
    expect(repo.transaction).toHaveBeenCalledTimes(2);
  });

  it('the bank filter reaches the card query', async () => {
    const { service, repo } = setup([totals({ id: 'c1', bank: 'UZCARD' })]);
    await service.allocate(request({ bank: 'UZCARD' }));
    expect(repo.cardTotals.mock.calls[0]?.[1]).toMatchObject({ bank: 'UZCARD' });
    const humo = setup([totals({ id: 'c1', bank: 'UZCARD' })]);
    expect(await errorOf(humo.service.allocate(request({ bank: 'HUMO' })))).toMatchObject({
      code: 'PAYMENT_METHOD_UNAVAILABLE',
    });
  });

  it('a card that lost its room under the lock is skipped; no card left -> 503', async () => {
    const { service, repo } = setup([totals({ id: 'c1' })]);
    repo.cardTotals
      .mockResolvedValueOnce([totals({ id: 'c1' })])
      .mockResolvedValueOnce([totals({ id: 'c1', receiveLimitTiyin: 1n })]);
    const error = await errorOf(service.allocate(request()));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'PAYMENT_METHOD_UNAVAILABLE' });
  });

  it('a lost amount race (23P01 or P2002 pending unique) is retried once, a second loss is 503', async () => {
    const once = setup([totals({ id: 'c1' })]);
    once.intents.insert.mockRejectedValueOnce(exclusion);
    await once.service.allocate(request());
    expect(once.intents.insert).toHaveBeenCalledTimes(2);

    const twice = setup([totals({ id: 'c1' })]);
    twice.intents.insert
      .mockRejectedValueOnce(exclusion)
      .mockRejectedValueOnce(unique('PaymentIntent_card_amount_pending_key'));
    expect(await errorOf(twice.service.allocate(request()))).toMatchObject({
      code: 'PAYMENT_METHOD_UNAVAILABLE',
    });
    expect(twice.intents.insert).toHaveBeenCalledTimes(2);
  });

  it('a lost per-user race becomes IntentInsertRace; any other error is rethrown as is', async () => {
    const pending = setup([totals({ id: 'c1' })]);
    pending.intents.insert.mockRejectedValueOnce(unique('PaymentIntent_user_pending_p2p_key'));
    const raced = await errorOf(pending.service.allocate(request()));
    expect(raced).toBeInstanceOf(IntentInsertRace);
    expect(raced).toMatchObject({ conflict: 'USER_PENDING' });

    const boom = new Error('connection reset');
    const other = setup([totals({ id: 'c1' })]);
    other.intents.insert.mockRejectedValueOnce(boom);
    expect(await errorOf(other.service.allocate(request()))).toBe(boom);
  });

  it('the injected random picks the suffix: 0 is the smallest free one (base + 1 som)', async () => {
    const { service, inserted } = setup([totals({ id: 'c1' })]);
    await service.allocate(request());
    expect(inserted[0]?.amountTiyin).toBe(2_000_100n);
  });

  const lockTimeout = {
    code: 'P2010',
    meta: { driverAdapterError: { cause: { originalCode: '55P03' } } },
  };

  it('a busy card (lock_timeout 55P03) is skipped for the next card, one lock at a time (R-7)', async () => {
    const { service, repo, events } = setup([
      totals({ id: 'c1', receiveLimitTiyin: 9_000_000_000n }),
      totals({ id: 'c2' }),
    ]);
    repo.lockCard.mockRejectedValueOnce(lockTimeout);
    await service.allocate(request());
    // c1 ranks first (more room) and is busy: its transaction ended, then c2 in a new one.
    expect(events).toEqual(['lockTimeout', 'lockTimeout', 'lock:c2', 'insert:c2']);
    expect(repo.transaction).toHaveBeenCalledTimes(2);
  });

  it('every card busy: 503, not 500', async () => {
    const { service, repo } = setup([totals({ id: 'c1' }), totals({ id: 'c2' })]);
    repo.lockCard.mockRejectedValue(lockTimeout);
    const error = await errorOf(service.allocate(request()));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'PAYMENT_METHOD_UNAVAILABLE' });
    expect(repo.transaction).toHaveBeenCalledTimes(2);
  });

  it('a busy DATABASE (transaction P2028 or pool P2024 timeout) is 503 at once: no other card is tried', async () => {
    for (const busy of [{ code: 'P2028' }, { code: 'P2024' }]) {
      const { service, repo } = setup([totals({ id: 'c1' }), totals({ id: 'c2' })]);
      repo.transaction.mockRejectedValueOnce(busy);
      const error = await errorOf(service.allocate(request()));
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'PAYMENT_METHOD_UNAVAILABLE' });
      expect(repo.transaction).toHaveBeenCalledTimes(1);
    }
  });

  it('availability per bank needs room for the smallest request with the largest suffix', async () => {
    const need = 500_000n + 300n;
    const { service } = setup([
      totals({ id: 'c1', bank: 'HUMO', receiveLimitTiyin: need }),
      totals({ id: 'c2', bank: 'UZCARD', receiveLimitTiyin: need - 1n }),
    ]);
    expect(await service.availability(NOW)).toEqual({ HUMO: true, UZCARD: false });
  });
});
