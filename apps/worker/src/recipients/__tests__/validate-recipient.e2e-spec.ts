import { RecipientCheckResultSchema } from '@repo/shared';
import { useRecipientE2e } from './recipient-e2e.harness';
import { username } from './recipient-e2e.fixtures';

// validate-recipient end to end (phase 5 S3b): a real BullMQ Worker with the production limiter
// and concurrency answers jobs added exactly like the API adds them, from the dry-run simulators.

const t = useRecipientE2e();
const asked: string[] = [];

/** A fresh username, remembered for the log check. */
function named(prefix: string): string {
  const name = username(prefix);
  asked.push(name);
  return name;
}

function ask(productId: string, raw: string, extra: { timestamp?: number } = {}) {
  asked.push(raw);
  return t.ask({ productId, input: { username: raw } }, extra);
}

describe('validate-recipient: the simulator answers by username shape', () => {
  it('found: a schema-valid answer, providerRef sim_<normalized>, @Name and name alike', async () => {
    const productId = await t.products.create();
    const name = username('az_');
    const spelled = `@${name.slice(0, 3).toUpperCase()}${name.slice(3)}`;
    const plain = await ask(productId, name);
    const decorated = await ask(productId, spelled);
    expect(plain).toEqual({ status: 'FOUND', providerRef: `sim_${name}`, displayName: name });
    expect(decorated).toEqual(plain);
    expect(RecipientCheckResultSchema.safeParse(plain).success).toBe(true);
  });

  it('notfound_* -> NOT_FOUND', async () => {
    const productId = await t.products.create();
    await expect(ask(productId, username('notfound_'))).resolves.toEqual({ status: 'NOT_FOUND' });
  });

  it('slowcheck_* -> UNAVAILABLE right at the deadline (job.timestamp + wait - margin)', async () => {
    const productId = await t.products.create();
    const job = await t.add({ productId, input: { username: named('slowcheck_') } });
    await expect(job.waitUntilFinished(t.events, 10_000)).resolves.toEqual({
      status: 'UNAVAILABLE',
    });
    const done = await t.jobOf(job.id);
    const took = (done?.finishedOn ?? 0) - job.timestamp;
    const deadline = t.timing.waitMs - t.timing.replyMarginMs;
    expect(took).toBeGreaterThanOrEqual(deadline - 50);
    expect(took).toBeLessThan(t.timing.waitMs);
    // An answer, not a throw: nothing for BullMQ to retry.
    expect(done?.attemptsMade).toBe(1);
    expect(done?.failedReason).toBeFalsy();
  });

  it('a slow check does not hold up a fast one (concurrency > 1)', async () => {
    const productId = await t.products.create();
    const slow = await t.add({ productId, input: { username: named('slowcheck_') } });
    const fast = await t.add({ productId, input: { username: named('fast') } });
    const order: string[] = [];
    await Promise.all([
      slow.waitUntilFinished(t.events, 10_000).then(() => order.push('slow')),
      fast.waitUntilFinished(t.events, 10_000).then(() => order.push('fast')),
    ]);
    expect(order).toEqual(['fast', 'slow']);
    const fastDone = await t.jobOf(fast.id);
    expect((fastDone?.finishedOn ?? Infinity) - fast.timestamp).toBeLessThan(t.timing.waitMs);
  });

  it('the limiter: three instant checks start at least ~1 s apart (the Fragment guard)', async () => {
    const productId = await t.products.create();
    const jobs = [];
    for (let i = 0; i < 3; i += 1) {
      jobs.push(await t.add({ productId, input: { username: named('rate') } }));
    }
    await Promise.all(jobs.map((job) => job.waitUntilFinished(t.events, 10_000)));
    const started: number[] = [];
    for (const job of jobs) started.push((await t.jobOf(job.id))?.processedOn ?? 0);
    started.sort((a, b) => a - b);
    expect(started[0]).toBeGreaterThan(0);
    for (let i = 1; i < started.length; i += 1) {
      expect((started[i] ?? 0) - (started[i - 1] ?? 0)).toBeGreaterThanOrEqual(950);
    }
  });

  it('a stale job (the API stopped waiting) never reaches the provider', async () => {
    const productId = await t.products.create();
    const fragment = t.registry.get('FRAGMENT');
    if (fragment === undefined) throw new Error('the FRAGMENT simulator is missing');
    const spy = jest.spyOn(fragment, 'validateRecipient');
    try {
      const old = Date.now() - t.timing.waitMs;
      await expect(ask(productId, username('stale'), { timestamp: old })).resolves.toEqual({
        status: 'UNAVAILABLE',
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('the log lines say product, status, reason, adapter and duration only', async () => {
    const productId = await t.products.create();
    await ask(productId, username('logs'));
    const lines = t.capture
      .records()
      .map((record) => String(record['msg']))
      .filter((msg) => msg.startsWith('validate-recipient'));
    expect(lines).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^validate-recipient ${productId}: FOUND \\(ANSWERED\\) adapter=FRAGMENT \\d+ ms$`,
        ),
      ),
    );
    expect(lines).toContainEqual(expect.stringContaining('UNAVAILABLE (STALE)'));
    expect(lines).toContainEqual(expect.stringContaining('UNAVAILABLE (TIMEOUT) adapter=FRAGMENT'));
  });
});

afterAll(() => {
  // Nothing personal in the worker's output: no username (any spelling), no name, no providerRef
  // handle, no job id (an unkeyed hash of the username).
  const out = t.capture.text().toLowerCase();
  expect(out).not.toMatch(/sim_|vr-[0-9a-f]{8}|notfound_|slowcheck_/);
  for (const raw of asked) expect(out).not.toContain(raw.toLowerCase().replace(/^@/, ''));
});
