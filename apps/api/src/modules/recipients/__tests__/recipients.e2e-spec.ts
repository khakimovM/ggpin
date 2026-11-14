import { ValidateRecipientResponseSchema } from '@repo/shared';
import { recipientCheckJobId } from '../recipient-check.client';
import { RECIPIENT_CHECK_LIMIT } from '../recipients.service';
import { DISPLAY_NAME, useRecipientsE2e } from './recipients-e2e.helpers';

// Real Postgres and Redis; a fake BullMQ worker answers the validate-recipient queue (S3b's
// processor is the real one). The app clock is frozen per test, so the 60 s bucket is explicit.
describe('POST /recipients/validate (e2e)', () => {
  const t = useRecipientsE2e();
  const body = (username: string, productId = t.fixtures().stars.id) => ({
    productId,
    input: { username },
  });

  it('found: 200, token + displayName, warnings [], no photoUrl, no-store', async () => {
    const user = await t.newUser();
    const res = await t.validate(body(t.username('found_', 1)), user);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const data = ValidateRecipientResponseSchema.parse(res.body.data);
    expect(Object.keys(res.body.data ?? {}).sort()).toEqual([
      'displayName',
      'recipientToken',
      'warnings',
    ]);
    expect(data.displayName).toBe(DISPLAY_NAME);
    expect(data.warnings).toEqual([]);
    expect(JSON.stringify(res.body)).not.toMatch(/sim_|providerRef/);
  });

  it('the token is accepted by POST /quotes with the normalized username', async () => {
    const f = t.fixtures();
    const user = await t.newUser();
    const typed = `  @${t.username('Found_', 2).toUpperCase()} `;
    const res = await t.validate(body(typed), user, 'cookie+csrf');
    expect(res.status).toBe(200);
    const recipientToken = String(res.body.data?.['recipientToken']);
    const quote = await t.quote(
      { productId: f.stars.id, skuId: f.stars.sku50, recipientToken },
      user,
    );
    expect(quote.status).toBe(201);
    expect(quote.body.data?.['recipient']).toEqual({
      username: t.username('found_', 2),
      displayName: DISPLAY_NAME,
    });
  });

  it('another user cannot use the token, nor can it quote another product', async () => {
    const f = t.fixtures();
    const owner = await t.newUser();
    const stranger = await t.newUser();
    const res = await t.validate(body(t.username('found_', 3)), owner);
    const recipientToken = String(res.body.data?.['recipientToken']);
    const theirs = await t.quote(
      { productId: f.stars.id, skuId: f.stars.sku50, recipientToken },
      stranger,
    );
    expect(theirs.status).toBe(422);
    expect(theirs.body.error?.code).toBe('RECIPIENT_INVALID');
    const otherProduct = await t.quote(
      { productId: f.other.id, skuId: f.other.sku50, recipientToken },
      owner,
    );
    expect([otherProduct.status, otherProduct.body.error?.code]).toEqual([
      422,
      'RECIPIENT_INVALID',
    ]);
  });

  it('not found: 422 RECIPIENT_NOT_FOUND, no token, no-store', async () => {
    const user = await t.newUser();
    const res = await t.validate(body(t.username('notfound_', 1)), user);
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('RECIPIENT_NOT_FOUND');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toBeUndefined();
  });

  it('provider unavailable: 503 RECIPIENT_CHECK_UNAVAILABLE, never "not found"', async () => {
    const user = await t.newUser();
    const res = await t.validate(body(t.username('unavail_', 1)), user);
    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('RECIPIENT_CHECK_UNAVAILABLE');
  });

  it('invalid input: 400 with paths only; unknown key, bad value, extra body key', async () => {
    const user = await t.newUser();
    const f = t.fixtures();
    const cases: unknown[] = [
      body('no spaces here'),
      body('abc'),
      { productId: f.stars.id, input: { username: 'aziz_k', zone: '1' } },
      { productId: f.stars.id, input: {} },
      { ...body('aziz_k'), userId: user.id },
      { productId: 'not a cuid', input: { username: 'aziz_k' } },
    ];
    for (const payload of cases) {
      const res = await t.validate(payload, user);
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(res.body)).not.toContain('no spaces here');
    }
    // A missing key carries Zod's own code (docs/04: details.fields holds Zod issue codes).
    const missing = await t.validate({ productId: f.stars.id, input: {} }, user);
    expect(missing.body.error?.details).toEqual({
      fields: [{ path: 'input.username', code: 'invalid_type' }],
    });
  });

  it('unknown product 404, inactive 422 PRODUCT_UNAVAILABLE, no form 422', async () => {
    const user = await t.newUser();
    const f = t.fixtures();
    const unknown = await t.validate(body('aziz_k', 'zzzzzzzzzzzzzzzzzzzzzzzz'), user);
    expect([unknown.status, unknown.body.error?.code]).toEqual([404, 'NOT_FOUND']);
    const inactive = await t.validate(body('aziz_k', f.inactive.id), user);
    expect([inactive.status, inactive.body.error?.code]).toEqual([422, 'PRODUCT_UNAVAILABLE']);
    const noForm = await t.validate({ productId: f.noForm.id, input: {} }, user);
    expect([noForm.status, noForm.body.error?.code]).toEqual([422, 'PRODUCT_UNAVAILABLE']);
  });

  it('session required; a cookie session without the CSRF header is refused as 404', async () => {
    const user = await t.newUser();
    const anon = await t.validate(body(t.username('found_', 4)), null, 'none');
    expect([anon.status, anon.body.error?.code]).toEqual([401, 'UNAUTHORIZED']);
    const noCsrf = await t.validate(body(t.username('found_', 4)), user, 'cookie');
    expect([noCsrf.status, noCsrf.body.error?.code]).toEqual([404, 'NOT_FOUND']);
    const withCsrf = await t.validate(body(t.username('found_', 4)), user, 'cookie+csrf');
    expect(withCsrf.status).toBe(200);
  });

  it('the 21st check in a minute is 429 with Retry-After', async () => {
    const user = await t.newUser();
    for (let i = 0; i < RECIPIENT_CHECK_LIMIT.max; i += 1) {
      expect((await t.validate(body('bad value'), user)).status).toBe(400);
    }
    const limited = await t.validate(body(t.username('found_', 5)), user);
    expect([limited.status, limited.body.error?.code]).toEqual([429, 'RATE_LIMITED']);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(limited.headers['cache-control']).toBe('no-store');
  });

  it('the same input inside one 60 s bucket is one job; the next bucket asks again', async () => {
    const a = await t.newUser();
    const b = await t.newUser();
    const name = t.username('found_', 6);
    const before = t.processed.length;
    const first = await t.validate(body(name), a);
    const second = await t.validate(body(`@${name.toUpperCase()}`), b);
    expect([first.status, second.status]).toEqual([200, 200]);
    // Two users, two different tokens, one provider lookup.
    expect(first.body.data?.['recipientToken']).not.toBe(second.body.data?.['recipientToken']);
    expect(t.processed.length - before).toBe(1);

    t.setNow(new Date(t.base.getTime() + 60_000));
    const later = await t.validate(body(name), a);
    expect(later.status).toBe(200);
    expect(t.processed.length - before).toBe(2);
    expect(new Set(t.processed.slice(before)).size).toBe(2);
  });

  it('a worker slower than the wait: 503, no token', async () => {
    const user = await t.newUser();
    const res = await t.validate(body(t.username('slow_', 1)), user);
    expect([res.status, res.body.error?.code]).toEqual([503, 'RECIPIENT_CHECK_UNAVAILABLE']);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('no worker at all: 503, and the waiting job is removed instead of piling up', async () => {
    const user = await t.newUser();
    await t.stopWorker();
    try {
      const name = t.username('found_', 7);
      const res = await t.validate(body(name), user);
      expect([res.status, res.body.error?.code]).toEqual([503, 'RECIPIENT_CHECK_UNAVAILABLE']);
      const jobId = recipientCheckJobId(
        { productId: t.fixtures().stars.id, input: { username: name } },
        t.base,
      );
      expect(await t.queue().getJob(jobId)).toBeUndefined();
    } finally {
      t.startWorker();
    }
    // Back with a worker, the same question in the same bucket is asked again and answered.
    const again = await t.validate(body(t.username('found_', 7)), user);
    expect(again.status).toBe(200);
  });

  it('no username, display name or provider handle in the logs or on stderr', () => {
    // Every request above went through the real request logger and error filter; stderr also
    // holds every process warning (MaxListenersExceededWarning would name a job id).
    expect(t.stderr()).not.toMatch(/MaxListenersExceeded|vr-[0-9a-f]{8}|found_|sim_/);
    const output = t.logs.text();
    expect(output).toContain('request completed');
    expect(output).not.toContain(DISPLAY_NAME);
    expect(output).not.toMatch(/found_|notfound_|unavail_|slow_|sim_|vr-[0-9a-f]{8}/i);
  });
});
