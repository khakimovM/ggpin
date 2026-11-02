import { randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../../app.module';
import { configureApp } from '../../../app.setup';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { createHttpAdapter } from '../../../common/http/create-http-adapter';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import type { Env } from '../../../config/env';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { TokenCodec } from '../token-codec';
import { buildInitData } from './init-data.fixtures';

export interface MutableClock extends Clock {
  set(date: Date): void;
  advanceSec(seconds: number): void;
}

export interface AuthE2e {
  readonly env: Env;
  readonly clock: MutableClock;
  readonly codec: TokenCodec;
  readonly db: PrismaService['client'];
  /** A fresh Telegram id, remembered so cleanup removes exactly this file's rows. */
  readonly newTelegramId: () => number;
  readonly initDataFor: (
    telegramId: number,
    extra?: { startParam?: string; ageSec?: number; languageCode?: string },
  ) => string;
  readonly post: (
    url: string,
    payload: unknown,
    headers?: Record<string, string>,
  ) => ReturnType<NestFastifyApplication['inject']>;
  readonly get: (
    url: string,
    headers?: Record<string, string>,
  ) => ReturnType<NestFastifyApplication['inject']>;
  readonly patch: (
    url: string,
    payload: unknown,
    headers?: Record<string, string>,
  ) => ReturnType<NestFastifyApplication['inject']>;
  readonly csrfHeaders: Record<string, string>;
  readonly app: () => NestFastifyApplication;
}

// Registers beforeAll/afterAll for the calling describe: boots the real app on the `*_test`
// database (fresh in-memory throttler per call, so each describe has its own 5/min budget) with a
// movable clock, and deletes only the rows it created. Contains no test.
export function useAuthE2e(): AuthE2e {
  const env = buildE2eEnv();
  const clock: MutableClock = (() => {
    let current = new Date();
    return {
      now: () => current,
      set: (date) => {
        current = date;
      },
      advanceSec: (seconds) => {
        current = new Date(current.getTime() + seconds * 1000);
      },
    };
  })();
  const used = new Set<number>();
  let app: NestFastifyApplication;
  let db: PrismaService['client'];
  let codec: TokenCodec;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(env)] })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter(env), {
      logger: false,
    });
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(PrismaService).client;
    codec = app.get(TokenCodec);
  });

  afterAll(async () => {
    const rows = await db.user.findMany({
      where: { telegramId: { in: [...used].map(BigInt) } },
      select: { id: true },
    });
    const ids = rows.map((r) => r.id);
    await db.webSession.deleteMany({ where: { userId: { in: ids } } });
    await db.user.updateMany({ where: { id: { in: ids } }, data: { referredById: null } });
    await db.wallet.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  const csrfHeaders = { 'x-csrf-token': 'e2e', origin: env.WEB_URL };
  return {
    env,
    clock,
    csrfHeaders,
    get codec() {
      return codec;
    },
    get db() {
      return db;
    },
    app: () => app,
    // Under 2^53 (a valid initData id) and random enough that parallel suites on the shared
    // test database never collide.
    newTelegramId: () => {
      for (;;) {
        const id = Date.now() * 4000 + (randomBytes(2).readUInt16BE() % 4000);
        if (!used.has(id)) {
          used.add(id);
          return id;
        }
      }
    },
    initDataFor: (telegramId, extra = {}) =>
      buildInitData({
        botToken: env.TELEGRAM_BOT_TOKEN,
        authDate: Math.floor(clock.now().getTime() / 1000) - (extra.ageSec ?? 5),
        user: {
          id: telegramId,
          first_name: 'E2E',
          username: `e2e_${String(telegramId)}`,
          language_code: extra.languageCode ?? 'ru',
        },
        ...(extra.startParam !== undefined ? { startParam: extra.startParam } : {}),
      }),
    post: (url, payload, headers = {}) =>
      app.inject({ method: 'POST', url, payload: payload as object, headers }),
    get: (url, headers = {}) => app.inject({ method: 'GET', url, headers }),
    patch: (url, payload, headers = {}) =>
      app.inject({ method: 'PATCH', url, payload: payload as object, headers }),
  };
}
