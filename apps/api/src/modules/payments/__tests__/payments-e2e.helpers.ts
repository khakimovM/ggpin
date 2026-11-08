import { nextTestTelegramId } from '../../../config/__tests__/test-telegram-id';
import { randomBytes } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { CardBank, IntentStatus, TopupCard, TopupCardStatus } from '@repo/db';
import { BANK_FEED_HEARTBEAT_KEY, PAY_TOKEN_HEADER, QUEUES, notifyJobSchema } from '@repo/shared';
import type { Queue } from 'bullmq';
import {
  queueJobIds,
  removeJobsAddedSince,
} from '../../../infra/queue/__tests__/queue-jobs-cleanup';
import type { DestinationStream } from 'pino';
import { AppModule } from '../../../app.module';
import { configureApp } from '../../../app.setup';
import { createHttpAdapter } from '../../../common/http/create-http-adapter';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import type { Env } from '../../../config/env';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RedisService } from '../../../infra/redis/redis.service';
import { TokenCodec } from '../../auth/token-codec';
import { UsersService } from '../../users/users.service';
import { PAYMENT_METHODS_CACHE_KEY } from '../payment-methods.service';
import { payViewLimitKey } from '../pay-view.service';
import { topupRateKey } from '../topup-limits';
import { prepareCardPool, retire } from './payments-e2e.cards';
import { TEST_HOLDER, syntheticPan } from './payments.fixtures';

export interface Envelope {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string; readonly details?: Record<string, unknown> };
}
export interface Reply {
  readonly status: number;
  readonly headers: Record<string, unknown>;
  readonly body: Envelope;
}
export interface TestUser {
  readonly id: string;
  readonly bearer: Record<string, string>;
}
export interface UserOptions {
  /** Account age; default 0 (a new account). */
  readonly ageDays?: number;
  readonly locale?: 'uz' | 'ru';
  readonly firstName?: string;
  readonly username?: string;
}
export interface CardOptions {
  readonly bank?: CardBank;
  readonly status?: TopupCardStatus;
  readonly limitTiyin?: bigint;
  readonly monthlyLimitTiyin?: bigint;
  readonly autoCreditPaused?: boolean;
}
export interface FixtureIntent {
  readonly cardId: string;
  readonly baseTiyin: bigint;
  readonly suffixSom: number;
  readonly status: IntentStatus;
  readonly createdAt: Date;
  readonly reservedUntil: Date;
  readonly paidAt?: Date;
  /** Default createdAt + 30 min. */
  readonly expiresAt?: Date;
}

export const BASE_TIYIN = 2_000_000n; // 20 000 so'm
export const HUGE_LIMIT = 900_000_000_000_000n;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const createBody = (amountTiyin: bigint = BASE_TIYIN, extra: object = {}) => ({
  provider: 'P2P_CARD',
  amountTiyin: amountTiyin.toString(),
  purpose: 'TOPUP',
  ...extra,
});
export const newKey = (): string => `k_${randomBytes(12).toString('hex')}`;

/** The pay token of a pay link: everything after `#t=`. */
export function tokenOf(redirectUrl: unknown): string {
  const match = /#t=([A-Za-z0-9_-]{43})$/.exec(String(redirectUrl));
  if (match?.[1] === undefined) throw new Error('not a pay link');
  return match[1];
}

export interface PaymentsE2eOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly logDestination?: DestinationStream;
  /** Providers replaced by fixed values (e.g. the suffix random source). */
  readonly overrides?: readonly { readonly provide: symbol; readonly useValue: unknown }[];
}

// Boots the real app on the *_test database and Redis DB 15 (one app per file). Users, intents
// and audit rows are never deleted (restricted references, append-only audit): every test uses
// its own random users and cards. Before each test the bank-feed heartbeat is fresh and every
// card of earlier tests is retired, so a test sees exactly the cards it made.
export function usePaymentsE2e(options: PaymentsE2eOptions = {}) {
  const env: Env = buildE2eEnv(options.env);
  let app: NestFastifyApplication;
  let ipSeq = 0;
  const userIds: string[] = [];
  const cardIds: string[] = [];
  const liveCards: string[] = [];
  const jobIds = new Set<string>();
  let notifyBefore = new Set<string>(); // B5: every notify job a file adds is removed after it

  const db = (): PrismaService['client'] => app.get(PrismaService).client;
  const redis = (): RedisService['client'] => app.get(RedisService).client;
  const nextIp = (): string => {
    ipSeq += 1;
    return `10.${String(Math.floor(ipSeq / 65536) % 256)}.${String(Math.floor(ipSeq / 256) % 256)}.${String((ipSeq % 255) + 1)}`;
  };
  const heartbeat = async (ageMs = 0): Promise<void> => {
    await redis().set(BANK_FEED_HEARTBEAT_KEY, String(Date.now() - ageMs));
  };

  beforeAll(async () => {
    let builder = Test.createTestingModule({
      imports: [AppModule.register(env, { logDestination: options.logDestination })],
    });
    for (const o of options.overrides ?? []) {
      builder = builder.overrideProvider(o.provide).useValue(o.useValue);
    }
    const moduleRef = await builder.compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter(env), {
      bufferLogs: true,
    });
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    notifyBefore = await queueJobIds(app.get<Queue>(getQueueToken(QUEUES.NOTIFY)));
    await prepareCardPool(db());
  });

  beforeEach(async () => {
    await retire(db(), liveCards.splice(0));
    await redis().del(PAYMENT_METHODS_CACHE_KEY); // a cached answer of the previous test
    await heartbeat();
  });

  afterAll(async () => {
    await retire(db(), cardIds);
    const intents = await db().paymentIntent.findMany({
      where: { userId: { in: userIds } },
      select: { id: true },
    });
    const keys = [
      BANK_FEED_HEARTBEAT_KEY,
      PAYMENT_METHODS_CACHE_KEY,
      ...userIds.map(topupRateKey),
      ...intents.map((i) => payViewLimitKey(i.id)),
    ];
    await redis().del(...keys);
    const queue = app.get<Queue>(getQueueToken(QUEUES.NOTIFY));
    for (const id of jobIds) await queue.remove(id).catch(() => 0);
    await removeJobsAddedSince(queue, notifyBefore);
    // cardReservedHigh jobs of this file's cards (any request on a small-limit card may raise one).
    const ours = new Set(cardIds);
    for (const job of await queue.getJobs(['waiting', 'delayed', 'completed', 'failed'])) {
      const data = notifyJobSchema.safeParse(job.data);
      const alert = data.success && data.data.kind === 'OWNER_ALERT' ? data.data : null;
      const card = alert?.alert === 'cardReservedHigh' ? alert.refId : '';
      if (ours.has(card.split('_')[0] ?? '')) await job.remove().catch(() => 0);
    }
    await app.close();
  });

  const newUser = async (opts: UserOptions = {}): Promise<TestUser> => {
    const now = new Date();
    const telegramId = nextTestTelegramId();
    const { user } = await app.get(UsersService).ensureTelegramUser(
      {
        telegramId: BigInt(telegramId),
        firstName: opts.firstName ?? 'Payer',
        ...(opts.username === undefined ? {} : { username: opts.username }),
      },
      { now },
    );
    userIds.push(user.id);
    await db().user.update({
      where: { id: user.id },
      data: {
        locale: opts.locale ?? 'uz',
        createdAt: new Date(now.getTime() - (opts.ageDays ?? 0) * 24 * HOUR),
      },
    });
    const iat = Math.floor(now.getTime() / 1000);
    const token = app.get(TokenCodec).sign({ typ: 'tg', sub: user.id, iat, exp: iat + 3600 });
    return { id: user.id, bearer: { authorization: `Bearer ${token}` } };
  };

  /** A receiving card written directly (ACTIVE and verified unless told otherwise). */
  const card = async (opts: CardOptions = {}): Promise<TopupCard> => {
    const status = opts.status ?? 'ACTIVE';
    for (let attempt = 0; ; attempt += 1) {
      const pan = syntheticPan();
      try {
        const row = await db().topupCard.create({
          data: {
            bank: opts.bank ?? 'HUMO',
            pan,
            last4: pan.slice(-4),
            holderName: TEST_HOLDER,
            status,
            receiveLimitTiyin: opts.limitTiyin ?? HUGE_LIMIT,
            monthlyLimitTiyin: opts.monthlyLimitTiyin ?? null,
            verifyAmountTiyin: 100_100n,
            verifiedAt: status === 'VERIFYING' ? null : new Date(),
            retiredAt: status === 'RETIRED' ? new Date() : null,
            autoCreditPaused: opts.autoCreditPaused ?? false,
          },
        });
        cardIds.push(row.id);
        liveCards.push(row.id);
        return row;
      } catch (error) {
        if (attempt === 9) throw error; // a (bank, last4) clash with a live card: new PAN
      }
    }
  };

  /** An intent written directly (history the API did not create in this test). */
  const fixtureIntent = async (userId: string, f: FixtureIntent): Promise<string> => {
    const tag = randomBytes(8).toString('hex');
    const expiresAt = f.expiresAt ?? new Date(f.createdAt.getTime() + 30 * MINUTE);
    const row = await db().paymentIntent.create({
      data: {
        userId,
        provider: 'P2P_CARD',
        cardId: f.cardId,
        baseAmountTiyin: f.baseTiyin,
        amountTiyin: f.baseTiyin + BigInt(f.suffixSom) * 100n,
        status: f.status,
        purpose: 'TOPUP',
        idempotencyKey: `fx_${tag}`,
        requestHash: `fx_${tag}`,
        createdAt: f.createdAt,
        expiresAt,
        reservedUntil: f.reservedUntil,
        paidAt: f.paidAt ?? null,
      },
      select: { id: true },
    });
    return row.id;
  };

  const send = async (
    method: 'GET' | 'POST' | 'OPTIONS',
    path: string,
    headers: Record<string, string>,
    payload?: object,
    remoteAddress: string = nextIp(),
  ): Promise<Reply> => {
    const res = await app.inject({
      method,
      url: `/api/v1${path}`,
      headers,
      remoteAddress,
      ...(payload === undefined ? {} : { payload }),
    });
    const body = res.body === '' ? { success: false } : res.json<Envelope>();
    return { status: res.statusCode, headers: res.headers, body };
  };

  return {
    /** A card the code under test created: retired with the others. */
    adopt: (cardId: string) => {
      cardIds.push(cardId);
      liveCards.push(cardId);
    },
    /** A notify job id to remove from Redis after the file. */
    trackJob: (jobId: string) => {
      jobIds.add(jobId);
    },
    notifyQueue: () => app.get<Queue>(getQueueToken(QUEUES.NOTIFY)),
    app: () => app,
    db,
    redis,
    env,
    heartbeat,
    newUser,
    card,
    fixtureIntent,
    send,
    create: (user: TestUser, body: object = createBody(), key: string = newKey()) =>
      send('POST', '/payments/intents', { ...user.bearer, 'idempotency-key': key }, body),
    get: (path: string, user: TestUser | null) => send('GET', path, user?.bearer ?? {}),
    post: (path: string, user: TestUser, body: object = {}) =>
      send('POST', path, user.bearer, body),
    pay: (intentId: string, token: string | null, ip?: string) =>
      send(
        'GET',
        `/payments/pay/${intentId}`,
        token === null ? {} : { [PAY_TOKEN_HEADER]: token },
        undefined,
        ip,
      ),
  };
}

export type PaymentsE2e = ReturnType<typeof usePaymentsE2e>;
