import { ValidateRecipientResponseSchema } from '@repo/shared';
import { DISPLAY_NAME, useRecipientsE2e } from './recipients-e2e.helpers';

// Phase 6 S1 (owner Q1/Q3): "this account already has Premium", both shapes the real Fragment
// answer may take, on real Postgres and Redis. The fake worker answers the Premium fixture as the
// simulator does: `haspremium_` REFUSED HAS_PREMIUM (blocking 422, no token), `premiumext_` FOUND
// with the PREMIUM_EXTENDS notice (200 + warning). The same names on a Stars-like product are a
// plain FOUND.
describe('POST /recipients/validate: Premium already there (e2e)', () => {
  const t = useRecipientsE2e();
  const premium = (username: string) => ({
    productId: t.fixtures().premium.id,
    input: { username },
  });
  const tokenKeys = async (): Promise<string[]> => (await t.redis().keys('rcpt:*')).sort();

  it('blocking: 422 RECIPIENT_HAS_PREMIUM, no data, no token written, no-store', async () => {
    const user = await t.newUser();
    const before = await tokenKeys();
    const res = await t.validate(premium(t.username('haspremium_', 1)), user);
    expect([res.status, res.body.error?.code]).toEqual([422, 'RECIPIENT_HAS_PREMIUM']);
    expect(res.body.data).toBeUndefined();
    expect(res.body.error?.details).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await tokenKeys()).toEqual(before);
  });

  it('blocking: a refusal after a found recipient mints nothing; only the found one can be quoted', async () => {
    const f = t.fixtures();
    const user = await t.newUser();
    const foundName = t.username('found_', 2);
    const found = await t.validate(premium(foundName), user);
    expect(found.status).toBe(200);
    const foundToken = String(found.body.data?.['recipientToken']);
    const afterFound = await tokenKeys();

    const refused = await t.validate(premium(t.username('haspremium_', 2)), user);
    expect([refused.status, refused.body.error?.code]).toEqual([422, 'RECIPIENT_HAS_PREMIUM']);
    expect(JSON.stringify(refused.body)).not.toMatch(/recipientToken|haspremium_|sim_/);
    // Same user, same product: the refusal wrote no token and replaced none.
    expect(await tokenKeys()).toEqual(afterFound);

    // The one token this user holds still names the found recipient, never the refused one.
    const quote = await t.quote(
      { productId: f.premium.id, skuId: f.premium.sku3, recipientToken: foundToken },
      user,
    );
    expect(quote.status).toBe(201);
    expect(quote.body.data?.['recipient']).toEqual({
      username: foundName,
      displayName: DISPLAY_NAME,
    });
  });

  it('non-blocking: 200, a token and one PREMIUM_EXTENDS warning; the token quotes', async () => {
    const f = t.fixtures();
    const user = await t.newUser();
    const res = await t.validate(premium(t.username('premiumext_', 1)), user, 'cookie+csrf');
    expect(res.status).toBe(200);
    const data = ValidateRecipientResponseSchema.parse(res.body.data);
    expect(data.displayName).toBe(DISPLAY_NAME);
    expect(data.warnings).toEqual([
      { code: 'PREMIUM_EXTENDS', message: 'warnings.premiumExtends' },
    ]);
    expect(Object.keys(res.body.data ?? {}).sort()).toEqual([
      'displayName',
      'recipientToken',
      'warnings',
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/sim_|providerRef|notices/);
    const quote = await t.quote(
      { productId: f.premium.id, skuId: f.premium.sku3, recipientToken: data.recipientToken },
      user,
    );
    expect(quote.status).toBe(201);
  });

  it('an ordinary Premium recipient: 200 with warnings []', async () => {
    const user = await t.newUser();
    const res = await t.validate(premium(t.username('found_', 1)), user);
    expect(res.status).toBe(200);
    expect(res.body.data?.['warnings']).toEqual([]);
  });

  it('Stars never answers either: the same names are a plain FOUND with warnings []', async () => {
    const user = await t.newUser();
    for (const prefix of ['haspremium_', 'premiumext_']) {
      const res = await t.validate(
        { productId: t.fixtures().stars.id, input: { username: t.username(prefix, 9) } },
        user,
      );
      expect(res.status).toBe(200);
      expect(res.body.data?.['warnings']).toEqual([]);
    }
  });

  it('a refusal is a definite answer: reused inside its 60 s bucket, asked again in the next', async () => {
    const a = await t.newUser();
    const b = await t.newUser();
    const name = t.username('haspremium_', 3);
    const before = t.processed.length;
    const first = await t.validate(premium(name), a);
    const second = await t.validate(premium(`@${name.toUpperCase()}`), b);
    expect([first.status, second.status]).toEqual([422, 422]);
    expect(second.body.error?.code).toBe('RECIPIENT_HAS_PREMIUM');
    expect(t.processed.length - before).toBe(1);

    t.setNow(new Date(t.base.getTime() + 60_000));
    const later = await t.validate(premium(name), a);
    expect([later.status, later.body.error?.code]).toEqual([422, 'RECIPIENT_HAS_PREMIUM']);
    expect(t.processed.length - before).toBe(2);
  });

  it('no username, display name or provider handle in the logs or on stderr', () => {
    expect(t.stderr()).not.toMatch(/MaxListenersExceeded|vr-[0-9a-f]{8}|haspremium_|sim_/);
    const output = t.logs.text();
    expect(output).toContain('request completed');
    expect(output).not.toContain(DISPLAY_NAME);
    expect(output).not.toMatch(/haspremium_|premiumext_|found_|sim_|vr-[0-9a-f]{8}/i);
  });
});
