import { randomBytes } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  ACCESS_COOKIE_NAME,
  QUEUES,
  RecipientCheckRequestSchema,
  type RecipientCheckResult,
} from '@repo/shared';
import { Worker, type Queue } from 'bullmq';
import { AppModule } from '../../../app.module';
import { configureApp } from '../../../app.setup';
import { CLOCK } from '../../../common/clock/clock';
import { createHttpAdapter } from '../../../common/http/create-http-adapter';
import { CaptureStream } from '../../../common/logging/__tests__/capture-stream';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import { nextTestTelegramId } from '../../../config/__tests__/test-telegram-id';
import type { Env } from '../../../config/env';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RedisService } from '../../../infra/redis/redis.service';
import { TokenCodec } from '../../auth/token-codec';
import { UsersService } from '../../users/users.service';
import { quoteLimitKey } from '../../quotes/quotes.service';
import { RECIPIENT_CHECK_WAIT_MS } from '../recipient-check.client';
import { recipientTokenKey } from '../recipient-token.store';
import { recipientCheckLimitKey } from '../recipients.service';
import { buildRecipientFixtures, type RecipientFixtures } from './recipients-e2e.fixtures';

/** The e2e wait for the worker (production: 10 s). The slow worker takes longer than this. */
export const E2E_WAIT_MS = 1_000;
const SLOW_WORKER_MS = 2_500;
/** `lag_` answers within the wait, slowly enough for two requests to wait on one active job. */
const LAG_WORKER_MS = 300;
export const DISPLAY_NAME = 'Aziz Sim';

export interface Envelope {
  readonly success: boolean;
  readonly data?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly details?: unknown };
}
export interface Res {
  readonly status: number;
  readonly headers: Record<string, unknown>;
  readonly body: Envelope;
}
export interface TestUser {
  readonly id: string;
  readonly bearer: Record<string, string>;
  readonly cookie: Record<string, string>;
}
export type Auth = 'bearer' | 'cookie' | 'cookie+csrf' | 'none';

/**
 * Stand-in for the worker's validate-recipient processor (S3b), answering by the username's
 * prefix like the simulator: `notfound_` NOT_FOUND, `unavail_` UNAVAILABLE, `slow_` FOUND too
 * late, `lag_` FOUND after 300 ms, `crash_` throws (a failed job), anything else FOUND with
 * `sim_<username>` as the provider handle.
 */
function fakeAnswer(username: string): RecipientCheckResult {
  if (username.startsWith('notfound_')) return { status: 'NOT_FOUND' };
  if (username.startsWith('unavail_')) return { status: 'UNAVAILABLE' };
  return { status: 'FOUND', providerRef: `sim_${username}`, displayName: DISPLAY_NAME };
}

// One app per file: the request logger is process-wide, so the log capture is fixed at boot.
export function useRecipientsE2e() {
  const env: Env = { ...buildE2eEnv(), LOG_LEVEL: 'info' };
  const logs = new CaptureStream();
  const sfx = randomBytes(4).toString('hex');
  const base = new Date();
  let now = base;
  let app: NestFastifyApplication;
  let fixtures: RecipientFixtures | undefined;
  let worker: Worker | undefined;
  let ipSeq = 0;
  /** Ids of the jobs the fake worker processed, in order. */
  const processed: string[] = [];
  const userIds: string[] = [];
  const redisKeys = new Set<string>();
  /** Everything written to stderr and every process warning while the suite runs. */
  const stderr: string[] = [];
  const onWarning = (warning: Error): void => {
    stderr.push(`${warning.name}: ${warning.message}`);
  };
  let stderrSpy: jest.SpyInstance | undefined;

  const db = (): PrismaService['client'] => app.get(PrismaService).client;
  const queue = (): Queue => app.get<Queue>(getQueueToken(QUEUES.VALIDATE_RECIPIENT));
  const nextIp = (): string => {
    ipSeq += 1;
    return `10.${String(Math.floor(ipSeq / 65536) % 256)}.${String(Math.floor(ipSeq / 256) % 256)}.${String((ipSeq % 255) + 1)}`;
  };

  const startWorker = (): void => {
    worker = new Worker(
      QUEUES.VALIDATE_RECIPIENT,
      async (job) => {
        processed.push(job.id ?? '');
        const request = RecipientCheckRequestSchema.parse(job.data);
        const username = request.input['username'] ?? '';
        if (username.startsWith('crash_')) throw new Error('fake worker crash');
        const delayMs = username.startsWith('slow_')
          ? SLOW_WORKER_MS
          : username.startsWith('lag_')
            ? LAG_WORKER_MS
            : 0;
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return fakeAnswer(username);
      },
      { connection: { url: env.REDIS_URL, maxRetriesPerRequest: null }, concurrency: 4 },
    );
  };

  beforeAll(async () => {
    process.on('warning', onWarning);
    const realWrite = process.stderr.write.bind(process.stderr);
    stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
        stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return (realWrite as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
      });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(env, { logDestination: logs })],
    })
      .overrideProvider(CLOCK)
      .useValue({ now: () => now })
      .overrideProvider(RECIPIENT_CHECK_WAIT_MS)
      .useValue(E2E_WAIT_MS)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter(env), {
      logger: false,
    });
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    // The REAL validate-recipient queue on the e2e Redis DB (15) is emptied here and obliterated
    // in afterAll: no dev worker or API may use DB 15 while this runs (suites are serialised by
    // e2e-lock.sh and --runInBand). Jobs are removed, not the queue: obliterate would also delete
    // the meta hash the app's Queue wrote at boot (opts.maxLenEvents, the events stream bound).
    await queue().drain(true);
    for (const type of ['completed', 'failed', 'wait', 'delayed'] as const) {
      await queue().clean(0, 10_000, type);
    }
    fixtures = await buildRecipientFixtures(db(), base, sfx);
    startWorker();
  });

  afterEach(() => {
    now = base;
  });

  afterAll(async () => {
    process.off('warning', onWarning);
    stderrSpy?.mockRestore();
    await worker?.close();
    await queue().obliterate({ force: true });
    if (redisKeys.size > 0) await app.get(RedisService).client.del(...redisKeys);
    await db().quote.deleteMany({ where: { userId: { in: userIds } } });
    await db().webSession.deleteMany({ where: { userId: { in: userIds } } });
    await db().wallet.deleteMany({ where: { userId: { in: userIds } } });
    await db().user.deleteMany({ where: { id: { in: userIds } } });
    if (fixtures !== undefined) await fixtures.remove();
    await app.close();
  });

  const newUser = async (): Promise<TestUser> => {
    const { user } = await app
      .get(UsersService)
      .ensureTelegramUser({ telegramId: BigInt(nextTestTelegramId()), firstName: 'Rcpt' }, { now });
    userIds.push(user.id);
    redisKeys.add(recipientCheckLimitKey(user.id));
    redisKeys.add(quoteLimitKey(user.id));
    const familyId = `fam_${user.id}`;
    await db().webSession.create({
      data: {
        userId: user.id,
        familyId,
        refreshHash: `rh_${familyId}`,
        expiresAt: new Date(base.getTime() + 86_400_000),
      },
    });
    const iat = Math.floor(base.getTime() / 1000);
    const exp = iat + 6 * 3600;
    const codec = app.get(TokenCodec);
    const tg = codec.sign({ typ: 'tg', sub: user.id, iat, exp });
    const web = codec.sign({ typ: 'web', sub: user.id, sid: familyId, iat, exp });
    return {
      id: user.id,
      bearer: { authorization: `Bearer ${tg}` },
      cookie: { cookie: `${ACCESS_COOKIE_NAME}=${web}` },
    };
  };

  const headersFor = (user: TestUser | null, auth: Auth): Record<string, string> => {
    if (user === null || auth === 'none') return {};
    if (auth === 'bearer') return user.bearer;
    const origin = { origin: env.WEB_URL };
    return auth === 'cookie'
      ? { ...user.cookie, ...origin }
      : { ...user.cookie, ...origin, 'x-csrf-token': 'e2e' };
  };

  const post = async (
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<Res> => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1${path}`,
      payload: body as object,
      headers,
      remoteAddress: nextIp(),
    });
    const parsed: Res = {
      status: res.statusCode,
      headers: res.headers,
      body: res.json<Envelope>(),
    };
    const token = parsed.body.data?.['recipientToken'];
    if (typeof token === 'string') redisKeys.add(recipientTokenKey(token));
    return parsed;
  };

  return {
    env,
    logs,
    stderr: (): string => stderr.join(''),
    redis: () => app.get(RedisService).client,
    base,
    processed,
    fixtures: (): RecipientFixtures => {
      if (fixtures === undefined) throw new Error('fixtures are not built yet');
      return fixtures;
    },
    queue,
    setNow: (date: Date): void => {
      now = date;
    },
    newUser,
    /** A username unique to this run with the given simulator prefix. */
    username: (prefix: string, n: number): string => `${prefix}${sfx}_${String(n)}`,
    stopWorker: async (): Promise<void> => {
      await worker?.close();
      worker = undefined;
    },
    startWorker,
    validate: (body: unknown, user: TestUser | null, auth: Auth = 'bearer'): Promise<Res> =>
      post('/recipients/validate', body, headersFor(user, auth)),
    /** The same request with exactly these headers (a hand-made Origin, for instance). */
    validateWith: (body: unknown, headers: Record<string, string>): Promise<Res> =>
      post('/recipients/validate', body, headers),
    quote: (body: unknown, user: TestUser, auth: Auth = 'bearer'): Promise<Res> =>
      post('/quotes', body, headersFor(user, auth)),
  };
}
