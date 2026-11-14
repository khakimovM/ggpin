import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { InsufficientBalanceDetailsSchema } from '@repo/shared';
import { ORDER_CREATE_LIMIT } from '../orders.service';
import { insertDiscountCode } from './orders-e2e.fixtures';
import { newKey, useOrdersE2e } from './orders-e2e.helpers';

describe('POST /orders (e2e): refusals write nothing', () => {
  const t = useOrdersE2e();

  const nothingWritten = async (userId: string, quoteId?: string): Promise<void> => {
    const db = t.db();
    expect(await db.order.count({ where: { userId } })).toBe(0);
    expect(await db.ledgerEntry.count({ where: { userId, kind: 'PURCHASE' } })).toBe(0);
    if (quoteId !== undefined) {
      expect((await db.quote.findUniqueOrThrow({ where: { id: quoteId } })).usedAt).toBeNull();
    }
  };

  it('422 INSUFFICIENT_BALANCE with the server’s balance, required and shortfall', async () => {
    const user = await t.newUser();
    await t.fund(user.id, 500_000n);
    const quote = await t.quote(user.id);
    const res = await t.order(user, quote.id);
    expect([res.status, res.body.error?.code]).toEqual([422, 'INSUFFICIENT_BALANCE']);
    expect(InsufficientBalanceDetailsSchema.parse(res.body.error?.details)).toEqual({
      balance: '500000',
      required: '550000',
      shortfall: '50000',
    });
    expect(res.headers['cache-control']).toBe('no-store');
    await nothingWritten(user.id, quote.id);
  });

  it('422 for a balance below zero: details.balance is negative and passes the shared schema (D-60)', async () => {
    const user = await t.newUser();
    await t.fund(user.id, 100_000n);
    // A reversed top-up larger than what was left (the payment path writes it, D-41).
    await t.db().ledgerEntry.create({
      data: {
        userId: user.id,
        kind: 'TOPUP_REVERSAL',
        amountTiyin: -200_000n,
        refType: 'PAYMENT',
        refId: `e2e_orders_rev_${randomBytes(8).toString('hex')}`,
      },
    });
    const quote = await t.quote(user.id);
    const res = await t.order(user, quote.id);
    expect([res.status, res.body.error?.code]).toEqual([422, 'INSUFFICIENT_BALANCE']);
    expect(InsufficientBalanceDetailsSchema.parse(res.body.error?.details)).toEqual({
      balance: '-100000',
      required: '550000',
      shortfall: '650000',
    });
    await nothingWritten(user.id, quote.id);
  });

  it('404 for another user’s quote: the owner’s quote stays unused', async () => {
    const owner = await t.newUser();
    const thief = await t.newUser();
    await t.fund(thief.id, 1_000_000n);
    const quote = await t.quote(owner.id);
    const res = await t.order(thief, quote.id);
    expect([res.status, res.body.error?.code]).toEqual([404, 'NOT_FOUND']);
    await nothingWritten(thief.id, quote.id);
    await nothingWritten(owner.id);
  });

  it('404 for a quote id that does not exist', async () => {
    const user = await t.newUser();
    const res = await t.order(user, 'nosuchquote000000000000');
    expect([res.status, res.body.error?.code]).toEqual([404, 'NOT_FOUND']);
  });

  it('410 QUOTE_EXPIRED for an expired quote', async () => {
    const user = await t.newUser();
    await t.fund(user.id, 1_000_000n);
    const quote = await t.quote(user.id, { expiresAt: new Date(Date.now() - 1_000) });
    const res = await t.order(user, quote.id);
    expect([res.status, res.body.error?.code]).toEqual([410, 'QUOTE_EXPIRED']);
    await nothingWritten(user.id, quote.id);
  });

  it('410 QUOTE_EXPIRED for a Telegram quote without its providerRef, logged by quote id (audit L2)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const user = await t.newUser();
    await t.fund(user.id, 1_000_000n);
    const quote = await t.quote(user.id, { providerRef: null });
    const res = await t.order(user, quote.id);
    expect([res.status, res.body.error?.code]).toEqual([410, 'QUOTE_EXPIRED']);
    await nothingWritten(user.id, quote.id);
    expect(warn).toHaveBeenCalledWith(
      `quote ${quote.id} of a Telegram product has no providerRef: refused as expired`,
    );
  });

  it('403 PURCHASE_FROZEN for a frozen wallet (D-41)', async () => {
    const user = await t.newUser();
    await t.fund(user.id, 1_000_000n);
    await t.db().user.update({ where: { id: user.id }, data: { purchaseFrozen: true } });
    const quote = await t.quote(user.id);
    const res = await t.order(user, quote.id);
    expect([res.status, res.body.error?.code]).toEqual([403, 'PURCHASE_FROZEN']);
    await nothingWritten(user.id, quote.id);
  });

  it('403 USER_BLOCKED for a blocked user (the session guard)', async () => {
    const user = await t.newUser();
    await t.fund(user.id, 1_000_000n);
    const quote = await t.quote(user.id);
    await t.db().user.update({ where: { id: user.id }, data: { isBlocked: true } });
    const res = await t.order(user, quote.id);
    expect([res.status, res.body.error?.code]).toEqual([403, 'USER_BLOCKED']);
    await nothingWritten(user.id, quote.id);
  });

  it('a quote with a discount code (none before phase 10): 500, nothing written; once expired, 410', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const user = await t.newUser();
    await t.fund(user.id, 1_000_000n);
    const codeId = await insertDiscountCode(t.db(), user.id);
    const quote = await t.quote(user.id, { discountCodeId: codeId });
    const key = newKey();
    const res = await t.order(user, quote.id, { key });
    expect([res.status, res.body.error?.code]).toEqual([500, 'INTERNAL_ERROR']);
    await nothingWritten(user.id, quote.id);
    // The client retries the same key while in doubt; the quote's expiry settles it.
    t.setNow(new Date(quote.expiresAt.getTime() + 1_000));
    const later = await t.order(user, quote.id, { key });
    expect([later.status, later.body.error?.code]).toEqual([410, 'QUOTE_EXPIRED']);
    await nothingWritten(user.id, quote.id);
  });

  it(`429 RATE_LIMITED + Retry-After on purchase ${String(ORDER_CREATE_LIMIT.max + 1)} of a minute`, async () => {
    const user = await t.newUser();
    await t.fund(user.id, 1_000_000n);
    for (let i = 0; i < ORDER_CREATE_LIMIT.max; i += 1) {
      expect((await t.order(user, `missing${String(i)}`)).status).toBe(404);
    }
    const quote = await t.quote(user.id);
    const res = await t.order(user, quote.id);
    expect([res.status, res.body.error?.code]).toEqual([429, 'RATE_LIMITED']);
    const retryAfter = Number(res.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(ORDER_CREATE_LIMIT.windowSec);
    await nothingWritten(user.id, quote.id);
  });

  it.each([
    ['no Idempotency-Key', { key: null }, { path: 'Idempotency-Key', code: 'required' }],
    ['a 7-character key', { key: 'abcdefg' }, { path: 'Idempotency-Key', code: 'invalid_format' }],
    [
      'a key with a forbidden character',
      { key: 'abcdefgh!' },
      { path: 'Idempotency-Key', code: 'invalid_format' },
    ],
  ])('400 VALIDATION_ERROR for %s', async (_name, request, field) => {
    const user = await t.newUser();
    await t.fund(user.id, 1_000_000n);
    const quote = await t.quote(user.id);
    const res = await t.order(user, quote.id, request);
    expect([res.status, res.body.error?.code]).toEqual([400, 'VALIDATION_ERROR']);
    expect(res.body.error?.details).toEqual({ fields: [field] });
    await nothingWritten(user.id, quote.id);
  });

  it.each([
    ['an unknown field', (quoteId: string) => ({ quoteId, discountCode: 'X' })],
    ['no quoteId', () => ({})],
    ['a quoteId that is not an id', () => ({ quoteId: 'bad id!' })],
    ['a numeric quoteId', () => ({ quoteId: 42 })],
  ])('400 VALIDATION_ERROR for a body with %s', async (_name, body) => {
    const user = await t.newUser();
    await t.fund(user.id, 1_000_000n);
    const quote = await t.quote(user.id);
    const res = await t.order(user, quote.id, { body: body(quote.id) });
    expect([res.status, res.body.error?.code]).toEqual([400, 'VALIDATION_ERROR']);
    await nothingWritten(user.id, quote.id);
  });

  it('401 UNAUTHORIZED without a session', async () => {
    const user = await t.newUser();
    const quote = await t.quote(user.id);
    const res = await t.order(null, quote.id);
    expect([res.status, res.body.error?.code]).toEqual([401, 'UNAUTHORIZED']);
    await nothingWritten(user.id, quote.id);
  });
});
