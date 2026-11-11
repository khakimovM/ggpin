import type { PaymentIntent } from '@repo/db';
import type { CreateTopupIntentBody } from '@repo/shared';
import { AppError } from '../../../common/exceptions/app-error';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import type { BankFeedHealth } from '../bank-feed-health';
import type { CardReservedAlert } from '../card-reserved-alert';
import {
  IntentInsertRace,
  type AllocationRequest,
  type CardPoolService,
} from '../card-pool.service';
import type { TopupIntentsRepository, IntentWithCard } from '../topup-intents.repository';
import { TopupIntentsService, topupRequestHash } from '../topup-intents.service';
import type { TopupLimits } from '../topup-limits';
import { cardRow } from './payments.fixtures';

const NOW = new Date('2026-11-05T10:00:00.000Z');
const BODY: CreateTopupIntentBody = {
  provider: 'P2P_CARD',
  amountTiyin: '2000000',
  purpose: 'TOPUP',
};
const OWNER = {
  id: 'u1',
  createdAt: new Date('2026-01-01'),
  locale: 'uz' as const,
  firstName: 'Ali',
  username: null,
};

function row(overrides: Partial<IntentWithCard> = {}): IntentWithCard {
  return {
    id: 'intent_1',
    userId: 'u1',
    provider: 'P2P_CARD',
    amountTiyin: 2_034_100n,
    status: 'PENDING',
    purpose: 'TOPUP',
    quoteId: null,
    idempotencyKey: 'key-00000001',
    requestHash: topupRequestHash(BODY),
    expiresAt: new Date(NOW.getTime() + 1_800_000),
    cardId: 'card_a',
    baseAmountTiyin: 2_000_000n,
    paidAt: null,
    reservedUntil: new Date(NOW.getTime() + 1_800_000 + 86_400_000),
    payTokenHash: 'a'.repeat(64),
    createdAt: NOW,
    updatedAt: NOW,
    card: cardRow(),
    ...overrides,
  };
}

function setup() {
  const calls: string[] = [];
  const repo = {
    findOwner: jest.fn(() => Promise.resolve(OWNER)),
    findByKey: jest.fn((): Promise<IntentWithCard | null> => Promise.resolve(null)),
    findPending: jest.fn((): Promise<PaymentIntent | null> => {
      calls.push('pending');
      return Promise.resolve(null);
    }),
    expireOverdue: jest.fn((_now: Date, scope: { userId?: string; id?: string }) => {
      calls.push(scope.id === undefined ? 'expire:user' : 'expire:intent');
      return Promise.resolve(0);
    }),
    rotateToken: jest.fn(() => Promise.resolve(true)),
    findOwn: jest.fn((): Promise<IntentWithCard | null> => Promise.resolve(row())),
    listOwn: jest.fn((): Promise<IntentWithCard[]> => Promise.resolve([row()])),
    cancel: jest.fn((): Promise<boolean> => {
      calls.push('cancel');
      return Promise.resolve(true);
    }),
  };
  const step = (name: string) => (): Promise<void> => {
    calls.push(name);
    return Promise.resolve();
  };
  const limits = {
    enforceReservations: jest.fn(step('reservations')),
    enforceAmount: jest.fn(step('amount')),
  };
  const bankFeed = {
    isAlive: jest.fn((): Promise<boolean> => {
      calls.push('heartbeat');
      return Promise.resolve(true);
    }),
  };
  const cards = {
    allocate: jest.fn((request: AllocationRequest): Promise<IntentWithCard> => {
      calls.push('allocate');
      return Promise.resolve(row({ payTokenHash: request.hashFor('intent_1') }));
    }),
  };
  const reservedAlert = {
    checkAfterCreate: jest.fn((): Promise<void> => {
      calls.push('reservedCheck');
      return Promise.resolve();
    }),
  };
  const service = new TopupIntentsService(
    repo as unknown as TopupIntentsRepository,
    limits as unknown as TopupLimits,
    cards as unknown as CardPoolService,
    bankFeed as unknown as BankFeedHealth,
    reservedAlert as unknown as CardReservedAlert,
    buildTestEnv(),
    { now: () => NOW },
  );
  return { service, repo, limits, bankFeed, cards, reservedAlert, calls };
}

async function codeOf(promise: Promise<unknown>): Promise<{ code: string; details: unknown }> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error('expected an AppError');
  return { code: error.code, details: error.details };
}

describe('TopupIntentsService.create', () => {
  it('checks in the contract order: pending -> reservations -> amount -> heartbeat -> card', async () => {
    const { service, calls } = setup();
    const created = await service.create('u1', 'key-00000001', BODY);
    expect(calls).toEqual([
      'expire:user',
      'pending',
      'reservations',
      'amount',
      'heartbeat',
      'allocate',
      'reservedCheck',
    ]);
    expect(created.redirectUrl).toMatch(/\/pay\/intent_1\?locale=uz#t=[A-Za-z0-9_-]{43}$/);
  });

  it('the same body hashes the same with or without key order, a different bank does not', () => {
    expect(
      topupRequestHash({ purpose: 'TOPUP', amountTiyin: '2000000', provider: 'P2P_CARD' }),
    ).toBe(topupRequestHash(BODY));
    expect(topupRequestHash({ ...BODY, bank: 'HUMO' })).not.toBe(topupRequestHash(BODY));
  });

  it('after the INSERT the card is checked for the reserved share (D-42 (1)), with its id and the same now', async () => {
    const { service, reservedAlert } = setup();
    await service.create('u1', 'key-00000001', BODY);
    expect(reservedAlert.checkAfterCreate).toHaveBeenCalledWith('card_a', NOW);
  });

  it('a listener without heartbeat answers 503 and allocates nothing', async () => {
    const { service, bankFeed, cards } = setup();
    bankFeed.isAlive.mockResolvedValueOnce(false);
    expect((await codeOf(service.create('u1', 'key-00000001', BODY))).code).toBe(
      'PAYMENT_METHOD_UNAVAILABLE',
    );
    expect(cards.allocate).not.toHaveBeenCalled();
  });

  it('idempotent replay: same body -> same intent, NEW token (hash rotated), no new allocation', async () => {
    const { service, repo, cards } = setup();
    repo.findByKey.mockResolvedValueOnce(row());
    const replay = await service.create('u1', 'key-00000001', BODY);
    expect(replay.intentId).toBe('intent_1');
    expect(repo.rotateToken).toHaveBeenCalledTimes(1);
    expect(cards.allocate).not.toHaveBeenCalled();
  });

  it('idempotent replay: another body -> 409 IDEMPOTENCY_CONFLICT with the intent id, token untouched', async () => {
    const { service, repo } = setup();
    repo.findByKey.mockResolvedValueOnce(row());
    const result = await codeOf(
      service.create('u1', 'key-00000001', { ...BODY, amountTiyin: '3000000' }),
    );
    expect(result).toEqual({ code: 'IDEMPOTENCY_CONFLICT', details: { intentId: 'intent_1' } });
    expect(repo.rotateToken).not.toHaveBeenCalled();
  });

  it('idempotent replay of an intent no longer PENDING and unexpired -> 409 with the intent id', async () => {
    const { service, repo } = setup();
    repo.findByKey.mockResolvedValueOnce(row({ status: 'PAID' }));
    repo.rotateToken.mockResolvedValueOnce(false);
    expect(await codeOf(service.create('u1', 'key-00000001', BODY))).toEqual({
      code: 'IDEMPOTENCY_CONFLICT',
      details: { intentId: 'intent_1' },
    });
  });

  it('a PENDING request -> 409 TOPUP_ALREADY_PENDING; overdue ones of the user are expired first', async () => {
    const { service, repo } = setup();
    repo.findPending.mockResolvedValueOnce(
      row({ id: 'intent_old', idempotencyKey: 'key-other-01' }),
    );
    expect(await codeOf(service.create('u1', 'key-00000002', BODY))).toEqual({
      code: 'TOPUP_ALREADY_PENDING',
      details: { intentId: 'intent_old' },
    });
    expect(repo.expireOverdue).toHaveBeenCalledWith(NOW, { userId: 'u1' });
    const [expired] = repo.expireOverdue.mock.invocationCallOrder;
    const [readPending] = repo.findPending.mock.invocationCallOrder;
    expect(expired).toBeLessThan(readPending ?? 0);
  });

  it('losing the insert race on the same key answers as the replay; on the pending unique as 409', async () => {
    const { service, repo, cards } = setup();
    cards.allocate.mockRejectedValueOnce(new IntentInsertRace('IDEMPOTENCY_KEY'));
    repo.findByKey.mockResolvedValueOnce(null).mockResolvedValueOnce(row());
    expect((await service.create('u1', 'key-00000001', BODY)).intentId).toBe('intent_1');

    cards.allocate.mockRejectedValueOnce(new IntentInsertRace('USER_PENDING'));
    repo.findPending
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row({ id: 'intent_winner', idempotencyKey: 'key-other-01' }));
    expect(await codeOf(service.create('u1', 'key-00000004', BODY))).toEqual({
      code: 'TOPUP_ALREADY_PENDING',
      details: { intentId: 'intent_winner' },
    });
  });

  it('a PENDING twin with THIS key that committed first is answered as its replay, not 409', async () => {
    const { service, repo, cards } = setup();
    repo.findPending.mockResolvedValueOnce(row({ idempotencyKey: 'key-00000001' }));
    cards.allocate.mockRejectedValueOnce(new IntentInsertRace('IDEMPOTENCY_KEY'));
    repo.findByKey.mockResolvedValueOnce(null).mockResolvedValueOnce(row());
    expect((await service.create('u1', 'key-00000001', BODY)).intentId).toBe('intent_1');
    expect(cards.allocate).toHaveBeenCalledTimes(1);
  });

  it('a lost per-user race whose winner is already gone is tried once more, then 503 (never 500)', async () => {
    const { service, cards } = setup();
    cards.allocate.mockRejectedValue(new IntentInsertRace('USER_PENDING'));
    expect((await codeOf(service.create('u1', 'key-00000005', BODY))).code).toBe(
      'PAYMENT_METHOD_UNAVAILABLE',
    );
    expect(cards.allocate).toHaveBeenCalledTimes(2);

    const once = setup();
    once.cards.allocate.mockRejectedValueOnce(new IntentInsertRace('USER_PENDING'));
    expect((await once.service.create('u1', 'key-00000006', BODY)).intentId).toBe('intent_1');
    expect(once.cards.allocate).toHaveBeenCalledTimes(2);
  });
});

describe('TopupIntentsService session routes expire overdue requests first (M1)', () => {
  it('get and list run the one expiry, then read', async () => {
    const { service, repo, calls } = setup();
    await service.get('u1', 'intent_1');
    expect(repo.expireOverdue).toHaveBeenLastCalledWith(NOW, { userId: 'u1', id: 'intent_1' });
    await service.list('u1', { limit: 20 });
    expect(repo.expireOverdue).toHaveBeenLastCalledWith(NOW, { userId: 'u1' });
    expect(calls).toEqual(['expire:intent', 'expire:user']);
  });

  it('cancel expires first and cancels only before the deadline; a refused cancel is 404', async () => {
    const { service, repo, calls } = setup();
    expect(await service.cancel('u1', 'intent_1')).toEqual({
      intentId: 'intent_1',
      status: 'CANCELLED',
    });
    expect(calls).toEqual(['expire:intent', 'cancel']);
    expect(repo.cancel).toHaveBeenCalledWith('u1', 'intent_1', NOW);
    repo.cancel.mockResolvedValueOnce(false);
    expect((await codeOf(service.cancel('u1', 'intent_1'))).code).toBe('NOT_FOUND');
  });

  it('a pay-link rotation expires first; an overdue request gets no new link', async () => {
    const { service, repo } = setup();
    repo.rotateToken.mockResolvedValueOnce(false);
    expect((await codeOf(service.rotatePayLink('u1', 'intent_1'))).code).toBe('NOT_FOUND');
    expect(repo.expireOverdue).toHaveBeenCalledWith(NOW, { userId: 'u1', id: 'intent_1' });
  });
});
