import { Logger } from '@nestjs/common';
import { CreateOrderResponseSchema } from '@repo/shared';
import { ORDER_CREATE_LIMIT, orderCreateLimitKey } from '../orders.service';
import { BODY, HASH, IDEM, NOW, TX, failure, quoteRow, setup, storedRow } from './orders.fixtures';

const WRITES = ['insert', 'ledger', 'used'];
const silenceErrors = () =>
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

afterEach(() => {
  jest.restoreAllMocks();
});

describe('OrdersService.create: the purchase', () => {
  it('limit, then ONE transaction (lock, replay, quote, gate, balance, writes), effects after commit', async () => {
    const { service, calls } = setup();
    await service.create('u1', IDEM, BODY);
    expect(calls).toEqual([
      'limit',
      'begin',
      'lock',
      'replay',
      'quote',
      'gate',
      'balance',
      ...WRITES,
      'commit',
      'effects',
    ]);
  });

  it('answers { order } in the contract shape, PAID, the name in the default language', async () => {
    const { service } = setup();
    const out = await service.create('u1', IDEM, BODY);
    expect(CreateOrderResponseSchema.parse(out)).toEqual(out);
    expect(out.order).toMatchObject({
      id: 'o1',
      status: 'PAID',
      productName: 'Telegram Stars uz',
      priceTiyin: '550000',
      discountTiyin: '0',
      totalTiyin: '550000',
    });
  });

  it('copies the quote row itself, no discount, the key and the body hash; debits the total', async () => {
    const { service, repository } = setup();
    await service.create('u1', IDEM, BODY);
    expect(repository.createPaid).toHaveBeenCalledWith(TX, {
      userId: 'u1',
      quote: quoteRow(),
      discountTiyin: 0n,
      idempotencyKey: IDEM,
      requestHash: HASH,
    });
    expect(repository.appendPurchase).toHaveBeenCalledWith(TX, 'u1', 'o1', 550_000n);
    expect(repository.markQuoteUsed).toHaveBeenCalledWith(TX, 'u1', 'q1', NOW);
  });

  it('scopes every step to the session user and hands each one the transaction client', async () => {
    const { service, repository, counter, effects } = setup();
    await service.create('user-A', IDEM, BODY);
    expect(counter.hit).toHaveBeenCalledWith(orderCreateLimitKey('user-A'), 60);
    expect(repository.lockWallet).toHaveBeenCalledWith(TX, 'user-A');
    expect(repository.findByKey).toHaveBeenCalledWith('user-A', IDEM, TX);
    expect(repository.findOwnQuote).toHaveBeenCalledWith(TX, 'user-A', 'q1');
    expect(repository.purchaseGate).toHaveBeenCalledWith(TX, 'user-A');
    expect(repository.balance).toHaveBeenCalledWith(TX, 'user-A');
    expect(effects.afterPurchase).toHaveBeenCalledWith('user-A', 'o1');
  });

  it('a balance of exactly the total is enough', async () => {
    const { service, calls } = setup({ balance: 550_000n });
    await service.create('u1', IDEM, BODY);
    expect(calls).toContain('commit');
  });
});

describe('OrdersService.create: replay (D-49)', () => {
  it('same key and body: the stored order, before any quote check, nothing written', async () => {
    const { service, calls } = setup({ stored: storedRow() });
    const out = await service.create('u1', IDEM, BODY);
    expect(out.order.id).toBe('o1');
    expect(calls).toEqual(['limit', 'begin', 'lock', 'replay', 'commit', 'effects']);
  });

  it('an order that already moved on is answered as it is now, with no effect re-run', async () => {
    const { service, calls } = setup({ stored: storedRow({ status: 'DELIVERED' }) });
    const out = await service.create('u1', IDEM, BODY);
    expect(out.order.status).toBe('DELIVERED');
    expect(calls).not.toContain('effects');
  });

  it('same key, another body: 409 IDEMPOTENCY_CONFLICT without details, nothing written', async () => {
    const { service, calls } = setup({ stored: storedRow({ requestHash: 'f'.repeat(64) }) });
    const error = await failure(service.create('u1', IDEM, BODY));
    expect([error.code, error.details]).toEqual(['IDEMPOTENCY_CONFLICT', undefined]);
    expect(calls).toEqual(['limit', 'begin', 'lock', 'replay', 'rollback']);
  });
});

describe('OrdersService.create: refusals in the D-49 order, nothing written', () => {
  const expectNothingWritten = (calls: readonly string[]) => {
    for (const write of [...WRITES, 'commit', 'effects']) expect(calls).not.toContain(write);
  };
  const past = new Date(NOW.getTime() - 1);

  it('no quote of this user (missing or another user’s): 404', async () => {
    const { service, calls } = setup({ quote: null });
    expect((await failure(service.create('u1', IDEM, BODY))).code).toBe('NOT_FOUND');
    expectNothingWritten(calls);
  });

  it('purchases frozen: 403 PURCHASE_FROZEN, even for a used and expired quote', async () => {
    const quote = quoteRow({ usedAt: past, order: { id: 'o9', userId: 'u1' }, expiresAt: past });
    const { service, calls } = setup({ gate: { purchaseFrozen: true }, quote });
    expect((await failure(service.create('u1', IDEM, BODY))).code).toBe('PURCHASE_FROZEN');
    expectNothingWritten(calls);
  });

  it('used by the owner’s other order: 409 QUOTE_ALREADY_USED + orderId, even if expired', async () => {
    const quote = quoteRow({ usedAt: past, order: { id: 'o9', userId: 'u1' }, expiresAt: past });
    const { service, calls } = setup({ quote });
    const error = await failure(service.create('u1', IDEM, BODY));
    expect([error.code, error.details]).toEqual(['QUOTE_ALREADY_USED', { orderId: 'o9' }]);
    expectNothingWritten(calls);
  });

  it.each([
    ['usedAt without an order', quoteRow({ usedAt: past })],
    ['an order of another user', quoteRow({ order: { id: 'o9', userId: 'u2' } })],
  ])('a quote marked used by %s: 500, logged, nothing written', async (_name, quote) => {
    const error = silenceErrors();
    const { service, calls } = setup({ quote });
    expect((await failure(service.create('u1', IDEM, BODY))).code).toBe('INTERNAL_ERROR');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('quote q1'));
    expectNothingWritten(calls);
  });

  it('expires AT expiresAt: 410 QUOTE_EXPIRED; a millisecond earlier it is still valid', async () => {
    const atExpiry = setup({ now: quoteRow().expiresAt });
    expect((await failure(atExpiry.service.create('u1', IDEM, BODY))).code).toBe('QUOTE_EXPIRED');
    expectNothingWritten(atExpiry.calls);
    const before = setup({ now: new Date(quoteRow().expiresAt.getTime() - 1) });
    await before.service.create('u1', IDEM, BODY);
    expect(before.calls).toContain('commit');
  });

  it('a quote with a discount code (none before phase 10): 500, logged, nothing written', async () => {
    const error = silenceErrors();
    const { service, calls } = setup({ quote: quoteRow({ discountCodeId: 'dc1' }) });
    expect((await failure(service.create('u1', IDEM, BODY))).code).toBe('INTERNAL_ERROR');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('discount code'));
    expectNothingWritten(calls);
    expect(calls).not.toContain('balance');
  });

  it('…and once that quote has expired the same request settles with 410', async () => {
    const quote = quoteRow({ discountCodeId: 'dc1', expiresAt: past });
    const { service } = setup({ quote });
    expect((await failure(service.create('u1', IDEM, BODY))).code).toBe('QUOTE_EXPIRED');
  });

  it('balance below the total: 422 with the server’s numbers', async () => {
    const { service, calls } = setup({ balance: 500_000n });
    const error = await failure(service.create('u1', IDEM, BODY));
    expect([error.code, error.details]).toEqual([
      'INSUFFICIENT_BALANCE',
      { balance: 500_000n, required: 550_000n, shortfall: 50_000n },
    ]);
    expectNothingWritten(calls);
  });

  it('a negative balance (reversed top-up, unfrozen by the owner): the shortfall includes the debt', async () => {
    const { service } = setup({ balance: -100_000n });
    const error = await failure(service.create('u1', IDEM, BODY));
    expect(error.details).toEqual({ balance: -100_000n, required: 550_000n, shortfall: 650_000n });
  });

  it(`purchase ${String(ORDER_CREATE_LIMIT.max + 1)} of the window: 429 + Retry-After, before the transaction`, async () => {
    const { service, calls } = setup({ hitCount: ORDER_CREATE_LIMIT.max + 1 });
    const error = await failure(service.create('u1', IDEM, BODY));
    expect([error.code, error.headers]).toEqual(['RATE_LIMITED', { 'Retry-After': '42' }]);
    expect(calls).toEqual(['limit']);
  });

  it(`purchase ${String(ORDER_CREATE_LIMIT.max)} of the window still goes through`, async () => {
    const { service, calls } = setup({ hitCount: ORDER_CREATE_LIMIT.max });
    await service.create('u1', IDEM, BODY);
    expect(calls).toContain('commit');
  });
});
