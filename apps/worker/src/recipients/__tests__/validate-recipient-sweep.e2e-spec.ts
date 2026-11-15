import { setTimeout as sleep } from 'node:timers/promises';
import { RedisService } from '../../infra/redis/redis.service';
import { RecipientJobSweeper } from '../recipient-job-sweeper';
import { useRecipientE2e } from './recipient-e2e.harness';
import { tag, username } from './recipient-e2e.fixtures';

// S3a review finding 2: BullMQ applies `removeOnComplete/removeOnFail.age` only when ANOTHER job
// finishes, and a job hash has no TTL, so on a quiet queue the last answer (username, name,
// providerRef) would stay in Redis. The worker's sweep removes it on its own. Shortened here
// (retention 1 s, period 0.5 s; production 60 s / 30 s): no other job finishes meanwhile.

const RETENTION_MS = 1_000;
const EVERY_MS = 500;
// The timer-driven checks below (no explicit sweep) allow for a loaded machine: retention + one
// period is the expectation, the bound is generous so a lagging timer is not a failure (N10).
const TIMER_BOUND_MS = RETENTION_MS + EVERY_MS + 8_000;
const t = useRecipientE2e({ timing: { retentionMs: RETENTION_MS, sweepEveryMs: EVERY_MS } });

async function goneWithin(id: string | undefined, ms: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if ((await t.jobOf(id)) === undefined) return Date.now() - started;
    await sleep(100);
  }
  throw new Error('the finished job is still in Redis');
}

/** The events stream as Redis holds it: [id, flat fields] entries. */
async function streamEntries(): Promise<[string, string[]][]> {
  const client = t.moduleRef.get(RedisService).client;
  return client.xrange(t.queue.toKey('events'), '-', '+');
}

const idMs = (id: string): number => Number(id.split('-')[0]);
const sweeper = () => t.moduleRef.get(RecipientJobSweeper);

async function serverMs(): Promise<number> {
  const [seconds, micros] = await t.moduleRef.get(RedisService).client.time();
  return Number(seconds) * 1_000 + Math.floor(Number(micros) / 1_000);
}

describe('validate-recipient retention sweep', () => {
  it('a completed job is gone after retention + one period, with no other job finishing', async () => {
    const productId = await t.products.create();
    const job = await t.add({ productId, input: { username: username('swept') } });
    await expect(job.waitUntilFinished(t.events, 10_000)).resolves.toEqual(
      expect.objectContaining({ status: 'FOUND' }),
    );
    // Still there inside the retention (the API may read it), then gone without any other job.
    expect(await t.jobOf(job.id)).toBeDefined();
    const waited = await goneWithin(job.id, TIMER_BOUND_MS);
    expect(waited).toBeGreaterThanOrEqual(RETENTION_MS - 300);
    expect(await t.queue.getJobCounts('completed', 'failed', 'active', 'wait')).toEqual(
      expect.objectContaining({ active: 0, wait: 0 }),
    );
  });

  it('the events stream keeps nothing older than the retention (audit L-2)', async () => {
    const productId = await t.products.create();
    const name = username('stream');
    const job = await t.add({ productId, input: { username: name } });
    await job.waitUntilFinished(t.events, 10_000);
    const mine = (entries: [string, string[]][]) =>
      entries.filter(([, fields]) =>
        fields.some((f) => f.includes(String(job.id)) || f.includes(name)),
      );
    // The answer (sim_<name>) and the job id are in the stream right after the job.
    const written = mine(await streamEntries());
    expect(written.length).toBeGreaterThan(0);
    const newest = Math.max(...written.map(([id]) => idMs(id)));
    // Decided by the REDIS clock and an awaited sweep, not by how soon this process's timer fires
    // (S7 re-review N10: under a loaded machine the 0.5 s timer could lag past a wall-clock bound).
    // `sweep()` joins a sweep already running, so the second call is one that started after now.
    const sweepNow = async () => {
      await sweeper().sweep();
      await sweeper().sweep();
    };
    await sweepNow();
    if ((await serverMs()) - newest < RETENTION_MS) {
      expect(mine(await streamEntries()).length).toBeGreaterThan(0); // younger: kept
    }
    while ((await serverMs()) <= newest + RETENTION_MS) await sleep(50);
    const before = await serverMs();
    await sweepNow();
    expect(mine(await streamEntries())).toEqual([]);
    const old = (await streamEntries()).filter(([id]) => idMs(id) < before - RETENTION_MS);
    expect(old).toEqual([]);
  });

  it('a failed job (invalid request) is swept the same way', async () => {
    const productId = await t.products.create();
    const job = await t.add({ productId }, { jobId: `vr-invalid-${tag()}` });
    await expect(job.waitUntilFinished(t.events, 10_000)).rejects.toThrow(/validate-recipient/);
    expect(await job.getState()).toBe('failed');
    await goneWithin(job.id, TIMER_BOUND_MS);
  });
});
