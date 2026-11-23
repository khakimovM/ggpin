import type { RecipientCheckRequest, RecipientCheckResult } from '@repo/shared';
import { AppError } from '../../../common/exceptions/app-error';
import type { FixedWindowCounter } from '../../../infra/redis/fixed-window-counter';
import type { RecipientCheckClient } from '../recipient-check.client';
import type { RecipientCheckGate } from '../recipient-check.gate';
import type { RecipientTokenStore } from '../recipient-token.store';
import type { RecipientProduct, RecipientsRepository } from '../recipients.repository';
import {
  RECIPIENT_CHECK_LIMIT,
  RecipientsService,
  recipientCheckLimitKey,
} from '../recipients.service';

const TG_FORM = [{ key: 'username', type: 'tgUsername', label: 'fields.tgUsername' }];
const PRODUCT: RecipientProduct = { id: 'p1', isActive: true, inputSchema: TG_FORM };
const TOKEN = 'T'.repeat(43);
const FOUND: RecipientCheckResult = {
  status: 'FOUND',
  providerRef: 'fragment-ref-1',
  displayName: 'Aziz',
};

interface Setup {
  readonly service: RecipientsService;
  readonly calls: string[];
  readonly check: jest.Mock<Promise<RecipientCheckResult>, [RecipientCheckRequest]>;
  readonly issue: jest.Mock;
  readonly hit: jest.Mock;
  readonly release: jest.Mock;
}

function setup(
  options: {
    product?: RecipientProduct | null;
    result?: RecipientCheckResult;
    count?: number;
    busySec?: number;
  } = {},
): Setup {
  const calls: string[] = [];
  const hit = jest.fn(() => {
    calls.push('limit');
    return Promise.resolve({ count: options.count ?? 1, ttlSec: 42 });
  });
  const findProduct = jest.fn(() => {
    calls.push('product');
    return Promise.resolve(options.product === undefined ? PRODUCT : options.product);
  });
  const check = jest.fn((_request: RecipientCheckRequest) => {
    calls.push('check');
    return Promise.resolve(options.result ?? FOUND);
  });
  const issue = jest.fn(() => {
    calls.push('token');
    return Promise.resolve(TOKEN);
  });
  const release = jest.fn(() => {
    calls.push('release');
    return Promise.resolve();
  });
  const acquire = jest.fn(() => {
    calls.push('slot');
    return Promise.resolve(
      options.busySec === undefined ? { release } : { retryAfterSec: options.busySec },
    );
  });
  const service = new RecipientsService(
    { findProduct } as unknown as RecipientsRepository,
    { check } as unknown as RecipientCheckClient,
    { issue } as unknown as RecipientTokenStore,
    { hit } as unknown as FixedWindowCounter,
    { acquire } as unknown as RecipientCheckGate,
  );
  return { service, calls, check, issue, hit, release };
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

const body = (username: string) => ({ productId: 'p1', input: { username } });

describe('RecipientsService.validate', () => {
  it('runs limit, product, slot, lookup, token, release in order; answers the contract shape', async () => {
    const { service, calls, hit } = setup();
    const out = await service.validate('u1', body('aziz_k'));
    expect(calls).toEqual(['limit', 'product', 'slot', 'check', 'token', 'release']);
    expect(hit).toHaveBeenCalledWith(recipientCheckLimitKey('u1'), RECIPIENT_CHECK_LIMIT.windowSec);
    // No photoUrl key at all (plan Q12), warnings always [].
    expect(out).toStrictEqual({ recipientToken: TOKEN, displayName: 'Aziz', warnings: [] });
  });

  it('asks the worker with the normalized input and binds the token to user and product', async () => {
    const { service, check, issue } = setup();
    await service.validate('u1', body('  @Aziz_K '));
    expect(check).toHaveBeenCalledWith({ productId: 'p1', input: { username: 'aziz_k' } });
    expect(issue).toHaveBeenCalledWith(
      'u1',
      'p1',
      { username: 'aziz_k', displayName: 'Aziz' },
      'fragment-ref-1',
    );
  });

  it('the 21st check in a window is 429 with Retry-After, before any lookup', async () => {
    const { service, calls } = setup({ count: RECIPIENT_CHECK_LIMIT.max + 1 });
    const error = await failure(service.validate('u1', body('aziz_k')));
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.headers).toEqual({ 'Retry-After': '42' });
    expect(calls).toEqual(['limit']);
  });

  it('the 20th check still passes', async () => {
    const { service } = setup({ count: RECIPIENT_CHECK_LIMIT.max });
    await expect(service.validate('u1', body('aziz_k'))).resolves.toMatchObject({
      recipientToken: TOKEN,
    });
  });

  it('unknown product is 404, inactive is 422 PRODUCT_UNAVAILABLE; no lookup', async () => {
    const unknown = setup({ product: null });
    expect((await failure(unknown.service.validate('u1', body('aziz_k')))).code).toBe('NOT_FOUND');
    const inactive = setup({ product: { ...PRODUCT, isActive: false } });
    expect((await failure(inactive.service.validate('u1', body('aziz_k')))).code).toBe(
      'PRODUCT_UNAVAILABLE',
    );
    expect(unknown.check).not.toHaveBeenCalled();
    expect(inactive.check).not.toHaveBeenCalled();
  });

  it('a product whose form is not one Telegram username cannot be validated yet', async () => {
    const { service, check } = setup({ product: { ...PRODUCT, inputSchema: [] } });
    expect((await failure(service.validate('u1', { productId: 'p1', input: {} }))).code).toBe(
      'PRODUCT_UNAVAILABLE',
    );
    expect(check).not.toHaveBeenCalled();
  });

  it('a stored form that does not parse is a server error, not a 400', async () => {
    const { service } = setup({ product: { ...PRODUCT, inputSchema: [{ key: 'x' }] } });
    await expect(service.validate('u1', body('aziz_k'))).rejects.not.toBeInstanceOf(AppError);
  });

  it('a bad value, a missing field or an unknown key is 400 with paths only', async () => {
    const { service, check } = setup();
    const bad = await failure(service.validate('u1', body('not a username')));
    expect(bad.code).toBe('VALIDATION_ERROR');
    expect(bad.details).toEqual({ fields: [{ path: 'input.username', code: 'invalid_format' }] });
    const extra = await failure(
      service.validate('u1', { productId: 'p1', input: { username: 'aziz_k', zone: '1' } }),
    );
    expect(extra.details).toEqual({ fields: [{ path: 'input.zone', code: 'unrecognized_keys' }] });
    const missing = await failure(service.validate('u1', { productId: 'p1', input: {} }));
    expect(missing.details).toEqual({ fields: [{ path: 'input.username', code: 'invalid_type' }] });
    expect(check).not.toHaveBeenCalled();
  });

  it('NOT_FOUND is 422 RECIPIENT_NOT_FOUND and issues no token', async () => {
    const { service, issue } = setup({ result: { status: 'NOT_FOUND' } });
    expect((await failure(service.validate('u1', body('aziz_k')))).code).toBe(
      'RECIPIENT_NOT_FOUND',
    );
    expect(issue).not.toHaveBeenCalled();
  });

  it('UNAVAILABLE is 503, never "not found", and issues no token', async () => {
    const { service, issue } = setup({ result: { status: 'UNAVAILABLE' } });
    expect((await failure(service.validate('u1', body('aziz_k')))).code).toBe(
      'RECIPIENT_CHECK_UNAVAILABLE',
    );
    expect(issue).not.toHaveBeenCalled();
  });

  it('a failing lookup propagates and issues no token', async () => {
    const { service, check, issue } = setup();
    check.mockRejectedValueOnce(new AppError('RECIPIENT_CHECK_UNAVAILABLE'));
    expect((await failure(service.validate('u1', body('aziz_k')))).code).toBe(
      'RECIPIENT_CHECK_UNAVAILABLE',
    );
    expect(issue).not.toHaveBeenCalled();
  });

  it('a second check while one runs is 429 with Retry-After, and no lookup is made', async () => {
    const { service, calls, check } = setup({ busySec: 7 });
    const error = await failure(service.validate('u1', body('aziz_k')));
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.headers).toEqual({ 'Retry-After': '7' });
    expect(check).not.toHaveBeenCalled();
    expect(calls).toEqual(['limit', 'product', 'slot']);
  });

  it('the slot is released after every outcome: not found, unavailable, a throw', async () => {
    for (const result of [{ status: 'NOT_FOUND' }, { status: 'UNAVAILABLE' }] as const) {
      const { service, release } = setup({ result });
      await failure(service.validate('u1', body('aziz_k')));
      expect(release).toHaveBeenCalledTimes(1);
    }
    const thrown = setup();
    thrown.check.mockRejectedValueOnce(new AppError('RECIPIENT_CHECK_UNAVAILABLE'));
    await failure(thrown.service.validate('u1', body('aziz_k')));
    expect(thrown.release).toHaveBeenCalledTimes(1);
  });

  it('no slot is taken for a request refused before the lookup', async () => {
    const { service, calls } = setup();
    await failure(service.validate('u1', body('not a username')));
    expect(calls).toEqual(['limit', 'product']);
  });

  it('an answer outside the allow-list (a future status) issues no token', async () => {
    const future = { status: 'HAS_PREMIUM' } as unknown as RecipientCheckResult;
    const { service, issue, release } = setup({ result: future });
    await expect(service.validate('u1', body('aziz_k'))).rejects.toThrow(
      'unexpected recipient check status',
    );
    expect(issue).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('RecipientsService.validate: Premium (phase 6, owner Q1/Q3)', () => {
  it('REFUSED HAS_PREMIUM is 422 RECIPIENT_HAS_PREMIUM: no token, the slot released', async () => {
    const result: RecipientCheckResult = { status: 'REFUSED', reason: 'HAS_PREMIUM' };
    const { service, issue, release, calls } = setup({ result });
    const error = await failure(service.validate('u1', body('aziz_k')));
    expect(error.code).toBe('RECIPIENT_HAS_PREMIUM');
    expect(error.details).toBeUndefined();
    expect(issue).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['limit', 'product', 'slot', 'check', 'release']);
  });

  it('an unknown refusal reason issues no token either (fail closed)', async () => {
    const result = { status: 'REFUSED', reason: 'KYC' } as unknown as RecipientCheckResult;
    const { service, issue } = setup({ result });
    await expect(service.validate('u1', body('aziz_k'))).rejects.toThrow(
      'unexpected recipient check status',
    );
    expect(issue).not.toHaveBeenCalled();
  });

  it('FOUND with PREMIUM_EXTENDS: 200 with the token and one warning (i18n key, no text)', async () => {
    const result: RecipientCheckResult = { ...FOUND, notices: ['PREMIUM_EXTENDS'] };
    const { service, issue } = setup({ result });
    const out = await service.validate('u1', body('aziz_k'));
    expect(out).toStrictEqual({
      recipientToken: TOKEN,
      displayName: 'Aziz',
      warnings: [{ code: 'PREMIUM_EXTENDS', message: 'warnings.premiumExtends' }],
    });
    // The notice is not part of the token: the token is the same as without it.
    expect(issue).toHaveBeenCalledWith(
      'u1',
      'p1',
      { username: 'aziz_k', displayName: 'Aziz' },
      'fragment-ref-1',
    );
  });

  it('FOUND with an empty notice list answers warnings []', async () => {
    const { service } = setup({ result: { ...FOUND, notices: [] } });
    await expect(service.validate('u1', body('aziz_k'))).resolves.toMatchObject({ warnings: [] });
  });
});
