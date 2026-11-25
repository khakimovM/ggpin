import { AppError } from '../../../common/exceptions/app-error';
import { BODY, IDEM, failure, setup, storedRow, uniqueViolation } from './orders.fixtures';

// Behind the wallet lock two purchases of one user never overlap, so these paths are the
// backstop of plan 6.1 step 4. The failed transaction is gone: the winner is read without it,
// in the D-49 order (the replay first, then "already used").
describe('OrdersService.create: a lost race', () => {
  it('usedAt already set at the write: rolled back, the winner’s order named in a 409', async () => {
    const { service, calls } = setup({ marked: false, orderIdByQuote: 'o7' });
    const error = await failure(service.create('u1', IDEM, BODY));
    expect([error.code, error.details]).toEqual(['QUOTE_ALREADY_USED', { orderId: 'o7' }]);
    expect(calls.slice(-4)).toEqual(['used', 'rollback', 'replay-after-race', 'order-by-quote']);
    expect(calls).not.toContain('effects');
  });

  it('the key won by a twin with the same body (unique index): its order is the 201', async () => {
    const { service, calls, effects } = setup({
      insertError: uniqueViolation('Order_userId_idempotencyKey_key'),
      storedAfterRace: storedRow({ id: 'o5' }),
    });
    const out = await service.create('u1', IDEM, BODY);
    expect(out.order.id).toBe('o5');
    expect(calls).not.toContain('ledger');
    expect(effects.afterPurchase).toHaveBeenCalledWith('u1', 'o5');
  });

  it('the quote won under another key (unique index): 409 QUOTE_ALREADY_USED + orderId', async () => {
    const { service, repository } = setup({
      insertError: uniqueViolation('Order_quoteId_key'),
      orderIdByQuote: 'o7',
    });
    const error = await failure(service.create('u1', IDEM, BODY));
    expect([error.code, error.details]).toEqual(['QUOTE_ALREADY_USED', { orderId: 'o7' }]);
    // Read without the transaction client (it is rolled back), scoped to the session user.
    expect(repository.findByKey).toHaveBeenLastCalledWith('u1', IDEM);
    expect(repository.findOwnOrderIdByQuote).toHaveBeenCalledWith('u1', 'q1');
  });

  it('a twin under the same key with ANOTHER body: 409 IDEMPOTENCY_CONFLICT', async () => {
    const { service } = setup({
      insertError: uniqueViolation('Order_quoteId_key'),
      storedAfterRace: storedRow({ requestHash: '0'.repeat(64) }),
      orderIdByQuote: 'o7',
    });
    expect((await failure(service.create('u1', IDEM, BODY))).code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('no winner to show: the original error stands (a 500)', async () => {
    const original = uniqueViolation('Order_quoteId_key');
    const { service } = setup({ insertError: original });
    await expect(service.create('u1', IDEM, BODY)).rejects.toBe(original);
  });

  it('a unique index that is not the order’s is no race: rethrown untouched', async () => {
    const original = uniqueViolation('LedgerEntry_refType_refId_kind_key');
    const { service, calls } = setup({ insertError: original });
    const error: unknown = await service.create('u1', IDEM, BODY).catch((e: unknown) => e);
    expect(error).toBe(original);
    expect(error).not.toBeInstanceOf(AppError);
    expect(calls).not.toContain('replay-after-race');
  });
});
