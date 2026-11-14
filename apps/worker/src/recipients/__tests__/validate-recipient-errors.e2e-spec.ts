import { setTimeout as sleep } from 'node:timers/promises';
import type { RecipientCheckResult } from '@repo/shared';
import { ValidateRecipientProcessor } from '../validate-recipient.processor';
import { useRecipientE2e } from './recipient-e2e.harness';
import { username } from './recipient-e2e.fixtures';
import { stubAdapter } from './recipient-test-doubles';

// Worker errors of validate-recipient (S3b review CR #3, audit L-1). BullMQ's own errors name the
// job id (an unkeyed hash of the username) and, with no `error` listener, go to console.error. The
// processor listens and logs the class name only. Real BullMQ Worker; one test really loses the
// job's lock mid-run (what the review's lock-error probe did to a bare Worker).

let lostLockOf: string | undefined;
const lockLoser = stubAdapter('STUB_LOCKLOSS', {
  // First call only: drop the running job's lock, as a stalled check or a Redis hiccup would.
  validate: async () => {
    if (lostLockOf === undefined) {
      const [active] = await t.queue.getActive();
      lostLockOf = active?.id;
      const client = await t.queue.client;
      if (lostLockOf !== undefined) await client.del(t.queue.toKey(`${lostLockOf}:lock`));
    }
    return { status: 'NOT_FOUND' } satisfies RecipientCheckResult;
  },
});
const t = useRecipientE2e({ adapters: [lockLoser] });

function stderrSpy(): string[] {
  const lines: string[] = [];
  jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
  });
  return lines;
}

const workerErrorLines = () =>
  t.capture
    .records()
    .map((record) => String(record['msg']))
    .filter((msg) => msg.startsWith('validate-recipient worker error'));

afterEach(() => jest.restoreAllMocks());

describe('validate-recipient: worker errors', () => {
  it('an error emitted by the worker: Pino gets the class name, stderr gets nothing', () => {
    const stderr = stderrSpy();
    const processor = t.moduleRef.get(ValidateRecipientProcessor);
    processor.worker.emit('error', new RangeError('Missing lock for job vr-0123456789abcdef'));
    expect(stderr).toEqual([]);
    expect(workerErrorLines()).toContain('validate-recipient worker error: RangeError');
    expect(t.capture.text()).not.toContain('vr-0123456789abcdef');
  });

  it('a lock really lost mid-run: logged without the job id, nothing on stderr', async () => {
    const stderr = stderrSpy();
    const productId = await t.products.create({ adapter: 'STUB_LOCKLOSS' });
    const before = workerErrorLines().length;
    const job = await t.add({ productId, input: { username: username('lock') } });
    for (let waited = 0; waited < 5_000 && workerErrorLines().length === before; waited += 50) {
      await sleep(50);
    }
    expect(lostLockOf).toBe(job.id);
    expect(workerErrorLines().length).toBeGreaterThan(before);
    expect(stderr.filter((line) => line.includes('vr-'))).toEqual([]);
    expect(t.capture.text()).not.toContain(String(job.id));
    // The orphaned active job (no lock any more) is removed so it is never run again.
    await t.queue.remove(String(job.id));
  });
});
