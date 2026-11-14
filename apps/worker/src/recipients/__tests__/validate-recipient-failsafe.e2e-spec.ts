import { useRecipientE2e } from './recipient-e2e.harness';
import { tag, username } from './recipient-e2e.fixtures';
import { stubAdapter } from './recipient-test-doubles';
import { guardNetwork } from './net-guard';

// validate-recipient fails CLOSED (phase 5 S3b): whatever keeps us from a provider's clear answer
// is UNAVAILABLE (the API: 503), never NOT_FOUND; nothing is retried after the API stopped
// waiting; an invalid request is a failed job, not retried; no value reaches a log line or a
// job's failedReason. Real BullMQ Worker, real Postgres/Redis, no network beyond them.

const SECRET_NAME = `Leaked Display ${tag()}`;
const thrower = stubAdapter('STUB_THROW', {
  validate: (_product, input) =>
    Promise.reject(new Error(`provider says user ${input['username'] ?? ''} is odd`)),
});
const down = stubAdapter('STUB_DOWN', { health: () => Promise.resolve('DOWN') });
const sick = stubAdapter('STUB_SICK', { health: () => Promise.reject(new Error('no health')) });
const malformed = stubAdapter('STUB_BAD', {
  validate: () =>
    Promise.resolve({ status: 'FOUND', providerRef: 'r1', displayName: SECRET_NAME.repeat(20) }),
});
const t = useRecipientE2e({ adapters: [thrower, down, sick, malformed] });
const asked: string[] = [];

async function ask(productId: string, prefix = 'u') {
  const name = username(prefix);
  asked.push(name);
  const job = await t.add({ productId, input: { username: name } });
  const answer: unknown = await job.waitUntilFinished(t.events, 10_000);
  return { answer, done: await t.jobOf(job.id) };
}

describe('validate-recipient: fail-closed answers', () => {
  it('an adapter throw -> UNAVAILABLE as an answer: one attempt, no retry', async () => {
    const productId = await t.products.create({ adapter: 'STUB_THROW' });
    const { answer, done } = await ask(productId);
    expect(answer).toEqual({ status: 'UNAVAILABLE' });
    expect(done?.attemptsMade).toBe(1);
    expect(done?.failedReason).toBeFalsy();
  });

  it.each([
    ['no route', { adapter: null }],
    ['an unhealthy adapter', { adapter: 'STUB_DOWN' }],
    ['an adapter whose health throws', { adapter: 'STUB_SICK' }],
    ['a route to an adapter this process does not have', { adapter: 'NOT_REGISTERED' }],
    ['an inactive product', { isActive: false }],
    ['a product with a broken form', { inputSchema: [{ key: 'username' }] }],
    ['a malformed provider answer (display name too long)', { adapter: 'STUB_BAD' }],
  ])('%s -> UNAVAILABLE', async (_, options) => {
    const productId = await t.products.create(options);
    await expect(ask(productId)).resolves.toEqual(
      expect.objectContaining({ answer: { status: 'UNAVAILABLE' } }),
    );
  });

  it('a product that does not exist -> UNAVAILABLE', async () => {
    await expect(ask(`cmnone${tag()}`)).resolves.toEqual(
      expect.objectContaining({ answer: { status: 'UNAVAILABLE' } }),
    );
  });
});

describe('validate-recipient: invalid requests', () => {
  it.each([
    ['an unknown key', (productId: string) => ({ productId, input: { username: 'u1' }, x: 1 })],
    ['no input', (productId: string) => ({ productId })],
    [
      'an input key the product form lacks',
      (productId: string) => ({ productId, input: { playerId: `p${tag()}` } }),
    ],
    [
      'a username that cannot be one',
      (productId: string) => ({ productId, input: { username: '1nvalid_name' } }),
    ],
  ])('%s: the job fails once, not retried, with a fixed reason', async (_, build) => {
    const productId = await t.products.create();
    const job = await t.add(build(productId), { jobId: `vr-invalid-${tag()}` });
    await expect(job.waitUntilFinished(t.events, 10_000)).rejects.toThrow(/validate-recipient/);
    const done = await t.jobOf(job.id);
    expect(done?.attemptsMade).toBe(1);
    expect(await done?.getState()).toBe('failed');
    expect(done?.failedReason).toMatch(
      /^(invalid validate-recipient request|validate-recipient input does not fit the product)$/,
    );
  });
});

describe('validate-recipient: dry run reaches only Postgres and Redis (plan §8)', () => {
  const net = guardNetwork([t.env.DATABASE_URL, t.env.REDIS_URL]);

  it('a found and a not-found lookup make no outside connection', async () => {
    const productId = await t.products.create();
    const found = await ask(productId);
    expect(found.answer).toEqual(expect.objectContaining({ status: 'FOUND' }));
    await expect(ask(productId, 'notfound_')).resolves.toEqual(
      expect.objectContaining({ answer: { status: 'NOT_FOUND' } }),
    );
    net.expectNoOutsideAccess();
  });
});

afterAll(() => {
  const out = t.capture.text().toLowerCase();
  expect(out).not.toMatch(
    /sim_|vr-[0-9a-f]{8}|vr-invalid|leaked display|provider says|1nvalid_name/,
  );
  for (const name of asked) expect(out).not.toContain(name);
});
