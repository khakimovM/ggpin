import { randomBytes } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Quote } from '@repo/db';
import { ACCESS_COOKIE_NAME, QUEUES, walletCacheKey } from '@repo/shared';
import type { Queue } from 'bullmq';
import type { DestinationStream } from 'pino';
import { AppModule } from '../../../app.module';
import { configureApp } from '../../../app.setup';
import { CLOCK } from '../../../common/clock/clock';
import { createHttpAdapter } from '../../../common/http/create-http-adapter';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import { nextTestTelegramId } from '../../../config/__tests__/test-telegram-id';
import type { Env } from '../../../config/env';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import {
  queueJobIds,
  removeJobsAddedSince,
} from '../../../infra/queue/__tests__/queue-jobs-cleanup';
import { RedisService } from '../../../infra/redis/redis.service';
import { TokenCodec } from '../../auth/token-codec';
import { UsersService } from '../../users/users.service';
import { orderCreateLimitKey } from '../orders.service';
import {
  buildOrdersCatalog,
  insertQuote,
  type OrdersCatalog,
  type QuoteOptions,
} from './orders-e2e.fixtures';

export interface Envelope {
  readonly success: boolean;
  readonly data?: unknown;
  readonly meta?: { page: number; limit: number; total: number };
  readonly error?: { readonly code: string; readonly message?: string; readonly details?: unknown };
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

export interface OrderRequest {
  /** Default: a fresh key for this call. `null`: no header at all. */
  readonly key?: string | null;
  readonly auth?: Auth;
  /** Replaces `{ quoteId }` (shape tests). */
  readonly body?: unknown;
}

const QUEUE_NAMES = [QUEUES.FULFILL_ORDER, QUEUES.NOTIFY] as const;

/** A valid Idempotency-Key (8-128 of A-Z a-z 0-9 _ -), unique per call. */
export const newKey = (): string => `k_${randomBytes(12).toString('hex')}`;

/** A response key that would carry an internal: cost, FX, snapshot, provider ref, key, reason. */
export const INTERNAL_KEY = /provider|cost|fx|snapshot|hash|idempotency|reason|actor|note/i;

/**
 * Every object key of a JSON value, at any depth. Leak checks match KEYS with a pattern and
 * known internal VALUES exactly: a pattern over the whole text could hit a random id.
 */
export function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
}

// Boots the real app on the *_test database and Redis DB 15 with a clock that is the REAL one
// unless a test sets it (the database guards judge quote expiry by the real clock, so purchases
// run on real time; only paths that write nothing move the app clock). Orders, ledger rows,
// events, quotes and users cannot be deleted (append-only triggers, Restrict FKs): the suite uses
// its own random users and ids and cleans what can be cleaned: Redis keys, the jobs it queued
// (fulfill-order and notify, nothing consumes them here), web sessions.
export function useOrdersE2e(options: { readonly logs?: DestinationStream } = {}) {
  const base = buildE2eEnv();
  const env: Env = options.logs === undefined ? base : { ...base, LOG_LEVEL: 'info' };
  const sfx = randomBytes(4).toString('hex');
  let fixedNow: Date | null = null;
  let app: NestFastifyApplication;
  let catalog: OrdersCatalog | undefined;
  let ipSeq = 0;
  const userIds: string[] = [];
  const jobsBefore = new Map<string, ReadonlySet<string>>();

  const db = (): PrismaService['client'] => app.get(PrismaService).client;
  const queue = (name: string): Queue => app.get<Queue>(getQueueToken(name));
  const nextIp = (): string => {
    ipSeq += 1;
    return `10.${String(Math.floor(ipSeq / 65536) % 256)}.${String(Math.floor(ipSeq / 256) % 256)}.${String((ipSeq % 255) + 1)}`;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(env, { logDestination: options.logs })],
    })
      .overrideProvider(CLOCK)
      .useValue({ now: () => fixedNow ?? new Date() })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter(env), {
      logger: false,
    });
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    for (const name of QUEUE_NAMES) jobsBefore.set(name, await queueJobIds(queue(name)));
    catalog = await buildOrdersCatalog(db(), sfx);
  });

  afterEach(() => {
    fixedNow = null;
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    const keys = userIds.flatMap((id) => [orderCreateLimitKey(id), walletCacheKey(id)]);
    if (keys.length > 0) await app.get(RedisService).client.del(...keys);
    for (const name of QUEUE_NAMES) {
      await removeJobsAddedSince(queue(name), jobsBefore.get(name) ?? new Set<string>());
    }
    await db().webSession.deleteMany({ where: { userId: { in: userIds } } });
    await app.close();
  });

  const headersFor = (user: TestUser | null, auth: Auth): Record<string, string> => {
    if (user === null || auth === 'none') return {};
    if (auth === 'bearer') return user.bearer;
    const origin = { origin: env.WEB_URL };
    return auth === 'cookie'
      ? { ...user.cookie, ...origin }
      : { ...user.cookie, ...origin, 'x-csrf-token': 'e2e' };
  };

  const inject = async (
    method: 'GET' | 'POST',
    path: string,
    headers: Record<string, string>,
    payload?: unknown,
  ): Promise<Res> => {
    const res = await app.inject({
      method,
      url: `/api/v1${path}`,
      headers,
      remoteAddress: nextIp(),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: res.statusCode, headers: res.headers, body: res.json<Envelope>() };
  };

  return {
    env,
    app: () => app,
    db,
    queue,
    catalog: (): OrdersCatalog => {
      if (catalog === undefined) throw new Error('the catalog is not built yet');
      return catalog;
    },
    /** `null` goes back to the real clock (also done after every test). */
    setNow: (date: Date | null): void => {
      fixedNow = date;
    },
    newUser: async (): Promise<TestUser> => {
      const now = new Date();
      // Unique across files, runs and jest workers (test-telegram-id.ts), under 2^53.
      const telegramId = BigInt(nextTestTelegramId());
      const { user } = await app
        .get(UsersService)
        .ensureTelegramUser({ telegramId, firstName: 'Orders' }, { now });
      userIds.push(user.id);
      const familyId = `fam_${user.id}`;
      await db().webSession.create({
        data: {
          userId: user.id,
          familyId,
          refreshHash: `rh_${familyId}`,
          expiresAt: new Date(now.getTime() + 86_400_000),
        },
      });
      const iat = Math.floor(now.getTime() / 1000);
      const exp = iat + 6 * 3600;
      const codec = app.get(TokenCodec);
      const tg = codec.sign({ typ: 'tg', sub: user.id, iat, exp });
      const web = codec.sign({ typ: 'web', sub: user.id, sid: familyId, iat, exp });
      return {
        id: user.id,
        bearer: { authorization: `Bearer ${tg}` },
        cookie: { cookie: `${ACCESS_COOKIE_NAME}=${web}` },
      };
    },
    /** A TOPUP entry (the test is the payment path); drops the cached balance. */
    fund: async (userId: string, amountTiyin: bigint): Promise<void> => {
      await db().ledgerEntry.create({
        data: {
          userId,
          kind: 'TOPUP',
          amountTiyin,
          refType: 'PAYMENT',
          refId: `e2e_orders_${randomBytes(8).toString('hex')}`,
        },
      });
      await app.get(RedisService).client.del(walletCacheKey(userId));
    },
    quote: (userId: string, quoteOptions: QuoteOptions = {}): Promise<Quote> => {
      if (catalog === undefined) throw new Error('the catalog is not built yet');
      return insertQuote(db(), catalog, userId, quoteOptions);
    },
    order: (user: TestUser | null, quoteId: string, request: OrderRequest = {}): Promise<Res> => {
      const key = request.key === undefined ? newKey() : request.key;
      const headers = {
        ...headersFor(user, request.auth ?? 'bearer'),
        ...(key === null ? {} : { 'idempotency-key': key }),
      };
      return inject('POST', '/orders', headers, request.body ?? { quoteId });
    },
    get: (path: string, user: TestUser | null, auth: Auth = 'bearer'): Promise<Res> =>
      inject('GET', path, headersFor(user, auth)),
  };
}

export type OrdersE2e = ReturnType<typeof useOrdersE2e>;
