import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { QUEUE_JOB_DEFAULTS, QUEUES, ownerAlertPriority, tgOutboxJobId } from '@repo/shared';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { ClockModule } from '../../../common/clock/clock.module';
import { AppConfigModule } from '../../../config/config.module';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import { PrismaModule } from '../../../infra/prisma/prisma.module';
import { QueueModule } from '../../../infra/queue/queue.module';
import { RedisModule } from '../../../infra/redis/redis.module';
import { RedisService } from '../../../infra/redis/redis.service';
import { NotificationsModule } from '../notifications.module';
import { TgOutboxConsumer, chatGateKey } from '../tg-outbox.consumer';
import { TgOutboxEnqueuer } from '../tg-outbox.enqueuer';
import { TG_OUTBOX_SENDER } from '../tg-outbox.sender';
import { TG_OUTBOX_CONCURRENCY, TG_OUTBOX_LIMITER } from '../tg-outbox.worker';
import { FakeSender, waitFor } from './tg-outbox.e2e-helpers';

/** The per-chat gap the consumer asks Redis for (`SET … PX`): asserted, never lowered. */
const CHAT_GAP_MS = 1_000;

// The consumer's gate command, run as one script that also returns the key's absolute expiry.
const SET_NX_WITH_EXPIRY = `if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then
  return redis.call('PEXPIRETIME', KEYS[1])
end
return false`;

/** One successful take of a chat's gate. */
interface GateTake {
  readonly chatId: string;
  /** The gate key's absolute expiry, Redis clock, integer ms (`PEXPIRETIME`). */
  readonly expiresAt: number;
  /** The PX the consumer asked for. */
  readonly px: number;
}

/**
 * Records every successful `SET tg-outbox:chat:<id> <v> PX <ms> NX` of the consumer (S9a fix
 * round). The SET runs unchanged, inside a script that also reads the key's expiry: one clock (the
 * Redis server's) and integers, so the check is exact, with no tolerance. A second NX on the key
 * succeeds only once the first PX has expired, so consecutive expiries are at least PX apart. The
 * first idea of this round (host `performance.now()` around the call) mixed two clocks: Redis runs
 * in a VM, and one run measured 999.6 ms. Any other SET (another shape, another key) goes through
 * untouched and is not recorded, so a gate taken without NX shows up as missing takes.
 */
function recordGateTakes(client: Redis): GateTake[] {
  const takes: GateTake[] = [];
  const prefix = chatGateKey('');
  const original = client.set.bind(client) as unknown as (...args: unknown[]) => Promise<unknown>;
  const spy = jest.spyOn(client, 'set') as unknown as jest.SpyInstance<Promise<unknown>, unknown[]>;
  spy.mockImplementation(async (...args: unknown[]) => {
    const [key, value, unit, px, mode] = args;
    const gate =
      args.length === 5 &&
      typeof key === 'string' &&
      key.startsWith(prefix) &&
      typeof value === 'string' &&
      unit === 'PX' &&
      typeof px === 'number' &&
      mode === 'NX';
    if (!gate) return original(...args);
    const expiresAt = await client.eval(SET_NX_WITH_EXPIRY, 1, key, value, String(px));
    if (typeof expiresAt !== 'number') return null; // the gate is closed: SET NX answers null
    takes.push({ chatId: key.slice(prefix.length), expiresAt, px });
    return 'OK';
  });
  return takes;
}

/** The chat's takes: one per delivery, each expiring at least the gap after the previous one. */
function expectGateHeld(takes: readonly GateTake[], chatId: string, deliveries: number): void {
  const own = takes.filter((t) => t.chatId === chatId).sort((a, b) => a.expiresAt - b.expiresAt);
  expect(own).toHaveLength(deliveries);
  for (const take of own) expect(take.px).toBe(CHAT_GAP_MS);
  for (let i = 1; i < own.length; i += 1) {
    const prev = own[i - 1]?.expiresAt ?? 0;
    const next = own[i]?.expiresAt ?? 0;
    expect(next - prev).toBeGreaterThanOrEqual(CHAT_GAP_MS);
  }
}

// Audit M-1 (b): a critical owner alert is sent before a flood of ordinary ones that were queued
// earlier, and the 1 msg/s per-chat gate still holds. Real Redis (DB 15) and BullMQ, the real
// tg-outbox consumer; only the Telegram transport is fake. The app boots with the bot off (no
// workers of its own); this file runs its own worker on a private queue name (concurrency 1 for
// the queued-order case, the production concurrency and limiter for the live flood), obliterated
// at the end. Synthetic chat ids, unique per run.
describe('tg-outbox priority (real Redis + BullMQ, fake transport)', () => {
  const env = buildE2eEnv();
  const queueName = `tg-outbox-prio-e2e-${randomUUID()}`;
  const queue = new Queue(queueName, {
    connection: { url: env.REDIS_URL },
    defaultJobOptions: QUEUE_JOB_DEFAULTS[QUEUES.TG_OUTBOX],
  });
  const enqueuer = new TgOutboxEnqueuer(queue);
  const sender = new FakeSender();
  let moduleRef: TestingModule;
  let worker: Worker | undefined;
  let takes: GateTake[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(env),
        ClockModule,
        PrismaModule,
        RedisModule,
        QueueModule,
        NotificationsModule,
      ],
    })
      .overrideProvider(TG_OUTBOX_SENDER)
      .useValue(sender)
      .compile();
    moduleRef.useLogger(false);
    await moduleRef.init();
    takes = recordGateTakes(moduleRef.get(RedisService).client);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await worker?.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await moduleRef.close();
  });

  it('50 queued `held` alerts, then `tonWalletCompromised`: the critical one is sent first', async () => {
    const owner = String(Date.now() * 1_000 + 7);
    const id = (kind: string, n: number) => tgOutboxJobId('alert', kind, String(n), owner);
    for (let n = 0; n < 50; n += 1) {
      await enqueuer.enqueue(
        id('held', n),
        { chatId: owner, text: `held ${String(n)}` },
        ownerAlertPriority('held'),
      );
    }
    await enqueuer.enqueue(
      id('tonWalletCompromised', 0),
      { chatId: owner, text: 'compromised' },
      ownerAlertPriority('tonWalletCompromised'),
    );
    expect(await queue.getJobCountByTypes('wait')).toBe(0); // all of them carry a priority
    expect(await queue.getJobCountByTypes('prioritized')).toBe(51);

    const consumer = moduleRef.get(TgOutboxConsumer);
    worker = new Worker(queueName, (job, token) => consumer.handle(job, token), {
      connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
      concurrency: 1,
    });
    await waitFor(() => sender.deliveriesTo(owner).length >= 3, 15_000);
    await worker.close();

    const sent = sender.deliveriesTo(owner);
    expect(sent[0]?.job.text).toBe('compromised');
    // The gated `held` jobs went to delayed and came back in their own (normal) tier: the next
    // deliveries are `held` ones, and the per-chat gate kept them a second apart.
    expect(sent.slice(1, 3).every((s) => s.job.text.startsWith('held '))).toBe(true);
    // The worker is closed: no take is waiting for its send, so takes and deliveries match.
    expectGateHeld(takes, owner, sent.length);
  }, 30_000);

  // Re-review MAJOR: the flood is ALREADY cycling through the chat gate (delayed, back, gated
  // again) when the critical message arrives. Before the fix the gated jobs came back in time
  // order and up to 8 `held` went out first; now at most the one already past the gate may.
  describe('a critical message during a live flood (production concurrency and limiter)', () => {
    let live: Worker | undefined;
    afterAll(async () => {
      await live?.close();
    });

    const runs = [
      ['tonWalletCompromised', 1],
      ['tonWalletCompromised', 2],
      ['tonWalletCompromised', 3],
      ['owner code (ephemeral)', 4],
    ] as const;

    it.each(runs)(
      '%s (run %s): at most one held is sent after it was queued',
      async (_kind, run) => {
        const owner = String(Date.now() * 1_000 + 100 + run);
        const id = (kind: string, n: number) => tgOutboxJobId('alert', kind, String(n), owner);
        const consumer = moduleRef.get(TgOutboxConsumer);
        live ??= new Worker(queueName, (job, token) => consumer.handle(job, token), {
          connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
          concurrency: TG_OUTBOX_CONCURRENCY,
          limiter: TG_OUTBOX_LIMITER,
        });
        for (let n = 0; n < 10; n += 1) {
          await enqueuer.enqueue(
            id('held', n),
            { chatId: owner, text: `held ${String(n)}` },
            ownerAlertPriority('held'),
          );
        }
        await waitFor(() => sender.deliveriesTo(owner).length >= 2, 30_000);
        const queuedAt = Date.now();
        const critical = { chatId: owner, text: 'critical' };
        if (run === 4) await enqueuer.enqueueEphemeral(`owner_otp-${owner}`, critical);
        else await enqueuer.enqueue(id('tonWalletCompromised', run), critical, 'critical');
        await waitFor(
          () => sender.deliveriesTo(owner).some((s) => s.job.text === 'critical'),
          30_000,
        );

        const sent = sender.deliveriesTo(owner);
        const at = sent.findIndex((s) => s.job.text === 'critical');
        const heldBetween = sent.slice(0, at).filter((s) => s.at >= queuedAt).length;
        expect(heldBetween).toBeLessThanOrEqual(1);
        // The gate still holds: all 11 messages of this chat went out a full gap apart (each
        // take happened before its send, and this chat has no other job left).
        await waitFor(() => sender.deliveriesTo(owner).length >= 11, 40_000);
        expectGateHeld(takes, owner, 11);
      },
      120_000,
    );
  });
});
