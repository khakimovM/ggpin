import { Logger } from '@nestjs/common';
import { BODY, IDEM, NOW, TX, failure, orderRow, quoteRow, setup } from './orders.fixtures';

const WRITES = ['insert', 'ledger', 'used', 'commit', 'effects'];
const expectNothingWritten = (calls: readonly string[]) => {
  for (const write of WRITES) expect(calls).not.toContain(write);
};
const past = new Date(NOW.getTime() - 1);

afterEach(() => {
  jest.restoreAllMocks();
});

// Review N2 / audit L1: the account flags are ONE read under the wallet lock, so a block or a
// freeze written while the purchase waited for the lock counts. Missing user: fail closed.
describe('OrdersService.create: the account gate under the lock', () => {
  it('blocked: 403 USER_BLOCKED, nothing written, even for a used and expired quote', async () => {
    const quote = quoteRow({ usedAt: past, order: { id: 'o9', userId: 'u1' }, expiresAt: past });
    const { service, calls } = setup({ gate: { isBlocked: true }, quote });
    expect((await failure(service.create('u1', IDEM, BODY))).code).toBe('USER_BLOCKED');
    expectNothingWritten(calls);
    expect(calls).not.toContain('balance');
  });

  it('blocked and frozen: the block is what the answer says', async () => {
    const { service } = setup({ gate: { isBlocked: true, purchaseFrozen: true } });
    expect((await failure(service.create('u1', IDEM, BODY))).code).toBe('USER_BLOCKED');
  });

  // Review N4: the internal user id (a cuid, no personal data) is what an operator needs.
  it('no user row beside the locked wallet: 500, logged with the internal user id, nothing written', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, calls } = setup({ gate: null });
    expect((await failure(service.create('u1', IDEM, BODY))).code).toBe('INTERNAL_ERROR');
    expect(error).toHaveBeenCalledWith('user u1 has a wallet but no user row: purchase refused');
    expectNothingWritten(calls);
  });
});

// Review N3: the PURCHASE entry is computed from the order row that was written.
describe('OrdersService.create: the debit', () => {
  it('is what the stored order costs: price - discount of the written row', async () => {
    const created = orderRow({ priceTiyin: 700_000n, discountTiyin: 100_000n });
    const quote = quoteRow({ priceTiyin: 600_000n });
    const { service, repository } = setup({ created, quote, balance: 1_000_000n });
    await service.create('u1', IDEM, BODY);
    expect(repository.appendPurchase).toHaveBeenCalledWith(TX, 'u1', 'o1', 600_000n);
  });

  // Review N3: the balance was checked against the quote's total; an order row that costs anything
  // else is a broken copy, so the transaction is rolled back before any debit.
  it.each([
    ['a higher price', { priceTiyin: 550_001n }],
    ['a lower price', { priceTiyin: 549_999n }],
    ['a discount', { discountTiyin: 1n }],
  ])('a written order with %s than its quote: 500, logged, rolled back', async (_case, over) => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, calls, repository } = setup({ created: orderRow(over) });
    expect((await failure(service.create('u1', IDEM, BODY))).code).toBe('INTERNAL_ERROR');
    expect(error).toHaveBeenCalledWith('order o1 costs other than its quote: purchase refused');
    expect(calls).toContain('rollback');
    for (const write of ['ledger', 'used', 'commit', 'effects']) expect(calls).not.toContain(write);
    expect(repository.appendPurchase).not.toHaveBeenCalled();
  });
});

// Audit L2: fulfillment re-checks a Telegram recipient by its providerRef; a quote without one is
// refused like an expired one (the client asks for a new quote), and the log names the quote only.
describe('OrdersService.create: a Telegram quote without its providerRef', () => {
  it.each([
    ['null', null],
    ['empty', ''],
    ['of spaces only (re-audit N2)', '   '],
  ])(
    'providerRef %s: 410 QUOTE_EXPIRED, a warning with the quote id only, nothing written',
    async (_case, providerRef) => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { service, calls } = setup({ quote: quoteRow({ providerRef }) });
      expect((await failure(service.create('u1', IDEM, BODY))).code).toBe('QUOTE_EXPIRED');
      expect(warn).toHaveBeenCalledWith(
        'quote q1 of a Telegram product has no providerRef: refused as expired',
      );
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/aziz_k|Aziz"|125000000/);
      expectNothingWritten(calls);
      expect(calls).not.toContain('balance');
    },
  );

  // Review M3: without a readable username there is nothing to re-check the handle against.
  it.each([
    ['a name only', { displayName: 'Aziz' }],
    ['a blank username', { username: '   ', displayName: 'Aziz' }],
    ['no recipient at all', null],
    ['an unreadable recipient', 'aziz_k'],
  ])(
    'a recipient with %s: 410 QUOTE_EXPIRED, a warning with the quote id only',
    async (_c, recipient) => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { service, calls } = setup({ quote: quoteRow({ recipient }) });
      expect((await failure(service.create('u1', IDEM, BODY))).code).toBe('QUOTE_EXPIRED');
      expect(warn).toHaveBeenCalledWith(
        'quote q1 of a Telegram product has no username: refused as expired',
      );
      expectNothingWritten(calls);
      expect(calls).not.toContain('balance');
    },
  );

  it('comes after "used" (409 + orderId) and after the expiry, like every 410', async () => {
    const used = quoteRow({ providerRef: null, usedAt: past, order: { id: 'o9', userId: 'u1' } });
    const first = setup({ quote: used });
    expect((await failure(first.service.create('u1', IDEM, BODY))).code).toBe('QUOTE_ALREADY_USED');
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const expired = setup({ quote: quoteRow({ providerRef: null, expiresAt: past }) });
    expect((await failure(expired.service.create('u1', IDEM, BODY))).code).toBe('QUOTE_EXPIRED');
    expect(warn).not.toHaveBeenCalled();
  });

  it('a product that is not delivered to a Telegram username is not held to it', async () => {
    const quote = quoteRow({ providerRef: null, product: { deliveryType: 'VOUCHER' } });
    const { service, calls } = setup({ quote });
    await service.create('u1', IDEM, BODY);
    expect(calls).toContain('commit');
  });
});
