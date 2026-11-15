import { RecipientCheckResultSchema } from '@repo/shared';
import { RecipientLookupService } from '../recipient-lookup.service';
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

/** Watches the budget the processor hands to the lookup (calls through unchanged). */
function budgetsSeen(): () => number[] {
  const spy = jest.spyOn(RecipientLookupService.prototype, 'check');
  return () => spy.mock.calls.map((call) => call[1]);
}

/** The processor's log lines about one product. */
function lookupLines(productId: string): string[] {
  return t.capture
    .records()
    .map((record) => String(record['msg']))
    .filter((msg) => msg.startsWith(`validate-recipient ${productId}:`));
}

afterEach(() => jest.restoreAllMocks());

function ask(productId: string, raw: string, extra: { timestamp?: number } = {}) {
  asked.push(raw);
  return t.ask({ productId, input: { username: raw } }, extra);
}

describe('validate-recipient: the simulator answers by username shape', () => {
  it('found: a schema-valid answer, providerRef FRAGMENT:sim_<normalized>, @Name and name alike', async () => {
    const productId = await t.products.create();
    const name = username('az_');
    const spelled = `@${name.slice(0, 3).toUpperCase()}${name.slice(3)}`;
    const plain = await ask(productId, name);
    const decorated = await ask(productId, spelled);
    expect(plain).toEqual({
      status: 'FOUND',
      providerRef: `FRAGMENT:sim_${name}`,
      displayName: name,
    });
    expect(decorated).toEqual(plain);
    expect(RecipientCheckResultSchema.safeParse(plain).success).toBe(true);
  });

  it('notfound_* -> NOT_FOUND', async () => {
    const productId = await t.products.create();
    await expect(ask(productId, username('notfound_'))).resolves.toEqual({ status: 'NOT_FOUND' });
  });

  it('slowcheck_* -> UNAVAILABLE by the deadline (job.timestamp + wait - margin), not by the provider', async () => {
    const productId = await t.products.create();
    const budgetsOf = budgetsSeen();
    const job = await t.add({ productId, input: { username: named('slowcheck_') } });
    await expect(job.waitUntilFinished(t.events, t.timing.waitMs + 5_000)).resolves.toEqual({
      status: 'UNAVAILABLE',
    });
    const done = await t.jobOf(job.id);
    // No wall-clock upper bound (S7 fix round 3: a GC stall in the shared Jest process is not a
    // late deadline). The deadline is proved by its formula: the processor read its clock after
    // the job became active (processedOn), so the budget it gave is at most
    // `job.timestamp + wait - margin - processedOn` (a budget without the margin is above it).
    const deadlineAt = job.timestamp + t.timing.waitMs - t.timing.replyMarginMs;
    const budgets = budgetsOf();
    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toBeLessThanOrEqual(deadlineAt - (done?.processedOn ?? Infinity));
    // The slot was held up to the deadline (a timer never fires early) ...
    expect(done?.finishedOn ?? 0).toBeGreaterThanOrEqual(deadlineAt - 50);
    // ... and it was the deadline that ended it, not the provider's own (much later) answer.
    expect(lookupLines(productId)).toEqual([
      expect.stringMatching(/: UNAVAILABLE \(TIMEOUT\) adapter=FRAGMENT \d+ ms$/),
    ]);
    // An answer, not a throw: nothing for BullMQ to retry.
    expect(done?.attemptsMade).toBe(1);
    expect(done?.failedReason).toBeFalsy();
  });

  it('a slow check does not hold up a fast one (concurrency > 1)', async () => {
    const productId = await t.products.create();
    const slow = await t.add({ productId, input: { username: named('slowcheck_') } });
    const fast = await t.add({ productId, input: { username: named('fast') } });
    const wait = t.timing.waitMs + 5_000;
    const answers: unknown[] = await Promise.all([
      slow.waitUntilFinished(t.events, wait),
      fast.waitUntilFinished(t.events, wait),
    ]);
    // Ordered by the jobs' own stamps, not by which wait resolved first (S7 fix round 3): the fast
    // check STARTED while the slow one was still running (one slot would make it wait for the slow
    // one's end), and it was answered by the provider within its own deadline (FOUND, ANSWERED).
    const slowDone = await t.jobOf(slow.id);
    const fastDone = await t.jobOf(fast.id);
    expect(fastDone?.processedOn ?? Infinity).toBeLessThan(slowDone?.finishedOn ?? 0);
    expect(answers[1]).toEqual(expect.objectContaining({ status: 'FOUND' }));
    expect(lookupLines(productId)).toContainEqual(
      expect.stringMatching(/: FOUND \(ANSWERED\) adapter=FRAGMENT \d+ ms$/),
    );
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
