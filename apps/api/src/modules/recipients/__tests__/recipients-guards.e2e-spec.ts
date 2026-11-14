import { QUEUE_EVENTS_MAX_LEN, QUEUES } from '@repo/shared';
import { recipientCheckJobId } from '../recipient-check.client';
import { recipientCheckBusyKey } from '../recipient-check.gate';
import { RECIPIENT_CHECK_LIMIT } from '../recipients.service';
import { useRecipientsE2e } from './recipients-e2e.helpers';

const TOKEN_KEY = /^rcpt:[0-9a-f]{64}$/;

// The fix round of S3a: one check at a time per user, outage answers not reused, failed jobs,
// shared waits, what counts toward the limit, Origin, the events stream bound, and stderr.
describe('POST /recipients/validate guards (e2e)', () => {
  const t = useRecipientsE2e();
  const body = (username: string) => ({ productId: t.fixtures().stars.id, input: { username } });
  const jobId = (username: string) =>
    recipientCheckJobId({ productId: t.fixtures().stars.id, input: { username } }, t.base);
  const tokenKeys = async (): Promise<string[]> =>
    (await t.redis().keys('rcpt:*')).filter((key) => TOKEN_KEY.test(key));

  it('one check at a time per user: a parallel second one is 429, no provider call', async () => {
    const user = await t.newUser();
    const other = await t.newUser();
    const before = t.processed.length;
    const first = t.validate(body(t.username('lag_', 1)), user);
    // Let the first one take its slot and enqueue.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await t.validate(body(t.username('found_', 1)), user);
    expect([second.status, second.body.error?.code]).toEqual([429, 'RATE_LIMITED']);
    const retryAfter = Number(second.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(2);
    // Another user is not held up by it.
    const theirs = await t.validate(body(t.username('found_', 2)), other);
    expect(theirs.status).toBe(200);
    expect((await first).status).toBe(200);
    // The busy request never reached the queue: two lookups, the lag_ one and the other user's.
    expect(t.processed.length - before).toBe(2);
    // Once the first is over, the slot is free again (and the key is gone, not just expired).
    expect(await t.redis().exists(recipientCheckBusyKey(user.id))).toBe(0);
    const again = await t.validate(body(t.username('found_', 1)), user);
    expect(again.status).toBe(200);
  });

  it('an UNAVAILABLE answer is not reused: the same question asks again in the same bucket', async () => {
    const user = await t.newUser();
    const name = t.username('unavail_', 1);
    const before = t.processed.length;
    for (let i = 0; i < 2; i += 1) {
      const res = await t.validate(body(name), user);
      expect([res.status, res.body.error?.code]).toEqual([503, 'RECIPIENT_CHECK_UNAVAILABLE']);
    }
    expect(t.processed.length - before).toBe(2);
    expect(await t.queue().getJob(jobId(name))).toBeUndefined();
  });

  it('NOT_FOUND is reused inside the bucket', async () => {
    const user = await t.newUser();
    const name = t.username('notfound_', 1);
    const before = t.processed.length;
    expect((await t.validate(body(name), user)).status).toBe(422);
    expect((await t.validate(body(name), user)).status).toBe(422);
    expect(t.processed.length - before).toBe(1);
  });

  it('a worker that throws: 503 at once (one attempt) and the failed job is removed', async () => {
    const user = await t.newUser();
    const name = t.username('crash_', 1);
    const started = Date.now();
    const res = await t.validate(body(name), user);
    expect([res.status, res.body.error?.code]).toEqual([503, 'RECIPIENT_CHECK_UNAVAILABLE']);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await t.queue().getJob(jobId(name))).toBeUndefined();
  });

  it('two users asking the same question at once share one active job: one provider call', async () => {
    const [a, b] = [await t.newUser(), await t.newUser()];
    const name = t.username('lag_', 2);
    const before = t.processed.length;
    const [ra, rb] = await Promise.all([t.validate(body(name), a), t.validate(body(name), b)]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(t.processed.length - before).toBe(1);
  });

  it('NOT_FOUND and UNAVAILABLE write no recipient token', async () => {
    const user = await t.newUser();
    const before = await tokenKeys();
    expect((await t.validate(body(t.username('notfound_', 2)), user)).status).toBe(422);
    expect((await t.validate(body(t.username('unavail_', 2)), user)).status).toBe(503);
    expect(await tokenKeys()).toEqual(before);
  });

  it('a body of the wrong shape does not count toward the limit', async () => {
    const user = await t.newUser();
    for (let i = 0; i < RECIPIENT_CHECK_LIMIT.max + 5; i += 1) {
      const res = await t.validate({ ...body('aziz_k'), extra: true }, user);
      expect(res.status).toBe(400);
    }
    expect((await t.validate(body(t.username('found_', 3)), user)).status).toBe(200);
  });

  it('a cookie session with a foreign Origin is refused as 404', async () => {
    const user = await t.newUser();
    const res = await t.validateWith(body(t.username('found_', 4)), {
      ...user.cookie,
      'x-csrf-token': 'e2e',
      origin: 'https://evil.example',
    });
    expect([res.status, res.body.error?.code]).toEqual([404, 'NOT_FOUND']);
  });

  it('the events stream is bounded: meta holds the shared maxLen and XADD trims to it', async () => {
    const maxLen = QUEUE_EVENTS_MAX_LEN[QUEUES.VALIDATE_RECIPIENT] ?? 0;
    const queue = t.queue();
    expect(await t.redis().hget(queue.toKey('meta'), 'opts.maxLenEvents')).toBe(String(maxLen));
    // Push well past the bound with no worker running (each add writes one `waiting` event).
    await t.stopWorker();
    try {
      const productId = t.fixtures().stars.id;
      await queue.addBulk(
        Array.from({ length: maxLen + 300 }, (_, i) => ({
          name: 'validate-recipient',
          data: { productId, input: { username: `bulk${String(i)}_x` } },
          opts: { jobId: `vr-bulk-${String(i)}` },
        })),
      );
      // MAXLEN ~ trims whole stream nodes (100 entries each by default): a little slack.
      expect(await t.redis().xlen(queue.toKey('events'))).toBeLessThanOrEqual(maxLen + 100);
    } finally {
      await queue.drain(true);
      t.startWorker();
    }
  });

  it('nothing personal and no warning on stderr or in the logs', () => {
    expect(t.stderr()).not.toMatch(/MaxListenersExceeded|vr-[0-9a-f]{8}|found_|lag_|crash_|sim_/);
    const output = t.logs.text();
    expect(output).toContain('request completed');
    expect(output).not.toMatch(/found_|lag_|crash_|unavail_|sim_|vr-[0-9a-f]{8}/i);
  });
});
