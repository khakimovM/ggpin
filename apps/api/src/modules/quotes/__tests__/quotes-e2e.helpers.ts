import { nextTestTelegramId } from '../../../config/__tests__/test-telegram-id';
import { randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ACCESS_COOKIE_NAME, type Recipient } from '@repo/shared';
import { AppModule } from '../../../app.module';
import { configureApp } from '../../../app.setup';
import { CLOCK } from '../../../common/clock/clock';
import { createHttpAdapter } from '../../../common/http/create-http-adapter';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import type { Env } from '../../../config/env';
import { TestDatabasePrismaService } from '../../../infra/prisma/__tests__/test-database-prisma.service';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RedisService } from '../../../infra/redis/redis.service';
import { TokenCodec } from '../../auth/token-codec';
import { RecipientTokenStore, recipientTokenKey } from '../../recipients/recipient-token.store';
import { UsersService } from '../../users/users.service';
import { quoteLimitKey } from '../quotes.service';

export const MINUTE_MS = 60_000;
export const RECIPIENT: Recipient = { username: 'aziz_k', displayName: 'Aziz' };

export interface Envelope {
  readonly success: boolean;
  readonly data?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly details?: unknown };
}

export interface TestUser {
  readonly id: string;
  readonly bearer: Record<string, string>;
  readonly cookie: Record<string, string>;
}

export type Auth = 'bearer' | 'cookie' | 'cookie+csrf' | 'none';

export interface QuotesE2e<F> {
  /** What the fixture builder returned (valid from beforeAll on). */
  readonly fixtures: () => F;
  readonly env: ReturnType<typeof buildE2eEnv>;
  readonly base: Date;
  readonly db: PrismaService['client'];
  readonly app: () => NestFastifyApplication;
  readonly setNow: (date: Date) => void;
  readonly newUser: () => Promise<TestUser>;
  /** A recipient token for (user, product), cleaned up with the suite. */
  readonly token: (userId: string, productId: string) => Promise<string>;
  readonly post: (
    body: unknown,
    user: TestUser | null,
    auth?: Auth,
  ) => Promise<{ status: number; headers: Record<string, unknown>; body: Envelope }>;
  readonly csrfHeaders: Record<string, string>;
  /** Registers a row created by the suite so afterAll removes it (quotes go first). */
  readonly track: (kind: Tracked, id: string) => void;
  /** An anonymous GET with its own source address (the per-IP limit is 120 a minute). */
  readonly get: (
    path: string,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; headers: Record<string, unknown>; body: Envelope }>;
}

export interface QuotesE2eOptions {
  /** Applied after loading, like the price book unit fixtures: lets a suite boot as NODE_ENV=production without the production-only env checks. */
  readonly config?: Partial<Env>;
}

// Boots the real app on the *_test database with a movable clock. The suite creates its own
// users, tokens and (through `fixtures`) catalog rows, and removes exactly those in afterAll:
// quotes first, because Quote references users, products, FX rates and cost snapshots with
// Restrict. `build` runs once after the app is up and registers the ids it creates.
export function useQuotesE2e<F>(
  build: (ctx: {
    readonly db: PrismaService['client'];
    readonly base: Date;
    readonly sfx: string;
    readonly track: (kind: Tracked, id: string) => void;
  }) => Promise<F>,
  options: QuotesE2eOptions = {},
): QuotesE2e<F> {
  const sfx = randomBytes(4).toString('hex');
  const env: Env = { ...buildE2eEnv(), ...options.config };
  const base = new Date();
  let now = base;
  let app: NestFastifyApplication;
  let db: PrismaService['client'];
  let built: F | undefined;
  let ipSeq = 0;
  const tracked: Record<Tracked, string[]> = {
    categories: [],
    products: [],
    skus: [],
    fxRates: [],
    snapshots: [],
  };
  const userIds: string[] = [];
  const redisKeys = new Set<string>();

  const nextIp = (): string => {
    ipSeq += 1;
    return `10.${String(Math.floor(ipSeq / 65536) % 256)}.${String(Math.floor(ipSeq / 256) % 256)}.${String((ipSeq % 255) + 1)}`;
  };

  beforeAll(async () => {
    const builder = Test.createTestingModule({ imports: [AppModule.register(env)] })
      .overrideProvider(CLOCK)
      .useValue({ now: () => now });
    if (env.NODE_ENV === 'production') {
      builder.overrideProvider(PrismaService).useClass(TestDatabasePrismaService);
    }
    const moduleRef = await builder.compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter(env), {
      logger: false,
    });
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(PrismaService).client;
    built = await build({
      db,
      base,
      sfx,
      track: (kind, id) => {
        tracked[kind].push(id);
      },
    });
  });

  afterAll(async () => {
    if (redisKeys.size > 0) await app.get(RedisService).client.del(...redisKeys);
    await db.quote.deleteMany({ where: { userId: { in: userIds } } });
    await db.webSession.deleteMany({ where: { userId: { in: userIds } } });
    await db.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.costSnapshot.deleteMany({ where: { id: { in: tracked.snapshots } } });
    await db.fxRate.deleteMany({ where: { id: { in: tracked.fxRates } } });
    await db.sku.deleteMany({ where: { id: { in: tracked.skus } } });
    await db.product.deleteMany({ where: { id: { in: tracked.products } } });
    await db.category.deleteMany({ where: { id: { in: tracked.categories } } });
    await app.close();
  });

  beforeEach(() => {
    now = base;
  });

  const csrfHeaders = { 'x-csrf-token': 'e2e', origin: env.WEB_URL };

  const newUser = async (): Promise<TestUser> => {
    // Unique across files, runs and jest workers (test-telegram-id.ts), under 2^53.
    const telegramId = nextTestTelegramId();
    const { user } = await app
      .get(UsersService)
      .ensureTelegramUser({ telegramId: BigInt(telegramId), firstName: 'Quote' }, { now });
    userIds.push(user.id);
    redisKeys.add(quoteLimitKey(user.id));

    const familyId = `fam_${user.id}`;
    await db.webSession.create({
      data: {
        userId: user.id,
        familyId,
        refreshHash: `rh_${familyId}`,
        expiresAt: new Date(base.getTime() + 86_400_000),
      },
    });
    const iat = Math.floor(base.getTime() / 1000);
    // Six hours: the freshness tests move the app clock by half an hour.
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

  return {
    fixtures: () => {
      if (built === undefined) throw new Error('fixtures are not built yet');
      return built;
    },
    env,
    base,
    get db() {
      return db;
    },
    app: () => app,
    setNow: (date) => {
      now = date;
    },
    newUser,
    token: async (userId, productId) => {
      const token = await app.get(RecipientTokenStore).issue(userId, productId, RECIPIENT);
      redisKeys.add(recipientTokenKey(token));
      return token;
    },
    csrfHeaders,
    track: (kind, id) => {
      tracked[kind].push(id);
    },
    get: async (path, headers = {}) => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1${path}`,
        headers,
        remoteAddress: nextIp(),
      });
      return { status: res.statusCode, headers: res.headers, body: res.json<Envelope>() };
    },
    post: async (body, user, auth = 'bearer') => {
      const headers: Record<string, string> =
        user === null || auth === 'none'
          ? {}
          : auth === 'bearer'
            ? user.bearer
            : auth === 'cookie'
              ? { ...user.cookie, origin: env.WEB_URL }
              : { ...user.cookie, ...csrfHeaders };
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/quotes',
        payload: body as object,
        headers,
        remoteAddress: nextIp(),
      });
      return { status: res.statusCode, headers: res.headers, body: res.json<Envelope>() };
    },
  };
}

export type Tracked = 'categories' | 'products' | 'skus' | 'fxRates' | 'snapshots';
