import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { ACCESS_COOKIE_NAME, CSRF_HEADER, QUEUES, adminSessionCookieName } from '@repo/shared';
import type { Queue } from 'bullmq';
import { AppModule } from '../../../app.module';
import { configureApp } from '../../../app.setup';
import { MONOTONIC_CLOCK } from '../../../common/admin/admin-deadline';
import { CLOCK } from '../../../common/clock/clock';
import { CaptureStream } from '../../../common/logging/__tests__/capture-stream';
import { createHttpAdapter } from '../../../common/http/create-http-adapter';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import { nextTestTelegramId } from '../../../config/__tests__/test-telegram-id';
import type { Env } from '../../../config/env';
import { TEST_WEBHOOK_SECRET } from '../../../config/__tests__/test-env';
import { TestDatabasePrismaService } from '../../../infra/prisma/__tests__/test-database-prisma.service';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RedisService } from '../../../infra/redis/redis.service';
import type { MutableClock } from '../../auth/__tests__/auth-e2e.helpers';
import { newLoginJobId } from '../../auth/new-login-notice.service';
import { OtpLoginService } from '../../auth/otp-login.service';
import { TG_OUTBOX_SENDER } from '../../notifications/tg-outbox.sender';
import { BOT } from '../../telegram/bot.provider';
import { UsersService } from '../../users/users.service';
import { AdminLoginService } from '../auth/admin-login.service';
import {
  adminAnonymousLimitKey,
  adminCodeRefusedLogKey,
  adminExportLimitKey,
  adminSessionLimitKey,
  adminWriteLimitKey,
} from '../common/admin-throttle';
import { maskTelegramId } from '../admins/admin-allowlist';
import {
  ADMIN_BASE,
  OWNER_CHATS,
  WEBHOOK_PATH,
  setCookies,
  type AdminE2e,
  type AdminE2eOptions,
} from './admin-e2e.api';
import { AdminProbeModule } from './admin-e2e.probe';

// Each jest worker gets its own 10.<n>.x.y range (its slot, read from a test Telegram id, which
// encodes it), so parallel admin suites on the shared Redis never share a per-IP bucket. Suites of
// one worker run one after another and each deletes exactly the keys it made.
const ipBlock = (): number => 100 + (nextTestTelegramId() % 64);

// One stream per test file: nestjs-pino keeps a process-wide root logger bound to the stream of the
// first app built, so every harness of the file must hand it the same one.
const logs = new CaptureStream();

export function useAdminE2e(options: AdminE2eOptions = {}): AdminE2e {
  const allowlist: bigint[] = [];
  const nodeEnv = options.nodeEnv ?? 'test';
  const env: Env = {
    ...buildE2eEnv({
      OWNER_ALERT_CHAT_ID: OWNER_CHATS.join(','),
      ...(options.bot === undefined
        ? {}
        : {
            TELEGRAM_BOT_MODE: 'webhook',
            TELEGRAM_WEBHOOK_URL: `https://hooks.example.test${WEBHOOK_PATH}`,
            TELEGRAM_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
          }),
    }),
    LOG_LEVEL: 'info',
    NODE_ENV: nodeEnv,
    ADMIN_TELEGRAM_IDS: allowlist,
  };
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
  const adminIds: string[] = [];
  const telegramIds: bigint[] = [];
  const nonces = new Set<string>();
  const ips = new Set<string>();
  const users: bigint[] = [];
  const block = ipBlock();
  let app: NestFastifyApplication;
  let ipSeq = 0;
  const closers: (() => Promise<unknown>)[] = []; // a suite's own clean-up, run while the app lives

  beforeAll(async () => {
    const builder = Test.createTestingModule({
      imports: [AppModule.register(env, { logDestination: logs }), AdminProbeModule],
    })
      .overrideProvider(CLOCK)
      .useValue(clock);
    // A production config on the *_test database: skip only the production database identity
    // check (D-52 r2), as the other production suites do.
    if (nodeEnv === 'production') {
      builder.overrideProvider(PrismaService).useClass(TestDatabasePrismaService);
    }
    if (options.monotonicClock !== undefined) {
      builder.overrideProvider(MONOTONIC_CLOCK).useValue(options.monotonicClock);
    }
    if (options.bot !== undefined) {
      builder.overrideProvider(BOT).useValue(options.bot.bot);
      // Webhook mode runs a real outbox worker on the shared queue: nothing may reach Telegram.
      builder.overrideProvider(TG_OUTBOX_SENDER).useValue({ send: () => Promise.resolve() });
    }
    const moduleRef = await builder.compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter(env), {
      logger: false,
    });
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    for (const close of closers) await close();
    const db = app.get(PrismaService).client;
    const sessions = await db.adminSession.findMany({
      where: { adminId: { in: adminIds } },
      select: { id: true },
    });
    const queue = app.get<Queue>(getQueueToken(QUEUES.TG_OUTBOX));
    for (const { id } of sessions) {
      await queue.remove(`adminlogin-${id}`);
      for (const chat of OWNER_CHATS) await queue.remove(`alert-adminLogin-${id}-${chat}`);
    }
    const keys = [
      ...[...ips].map(adminAnonymousLimitKey),
      ...sessions.flatMap(({ id }) => [
        adminSessionLimitKey(id),
        adminWriteLimitKey(id),
        adminExportLimitKey(id),
      ]),
      ...[...nonces].map((n) => `adm:login-origin:${createHash('sha256').update(n).digest('hex')}`),
      ...telegramIds.map((id) => adminCodeRefusedLogKey(maskTelegramId(id))),
    ];
    if (keys.length > 0) await app.get(RedisService).client.del(...keys);
    const userRows = await db.user.findMany({
      where: { telegramId: { in: [...users, ...telegramIds] } }, // the bot makes users too
      select: { id: true },
    });
    const userIds = userRows.map((u) => u.id);
    await db.loginRequest.deleteMany({
      where: {
        OR: [{ nonce: { in: [...nonces] } }, { telegramId: { in: [...telegramIds, ...users] } }],
      },
    });
    const families = await db.webSession.findMany({
      where: { userId: { in: userIds } },
      distinct: ['familyId'],
      select: { familyId: true },
    });
    for (const { familyId } of families) await queue.remove(newLoginJobId(familyId));
    await db.webSession.deleteMany({ where: { userId: { in: userIds } } });
    await db.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.adminSession.deleteMany({ where: { adminId: { in: adminIds } } });
    await db.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    await app.close();
  });

  const spa = (extra: Record<string, string> = {}) => ({
    origin: env.ADMIN_URL,
    'sec-fetch-site': 'same-site',
    'sec-fetch-mode': 'cors',
    [CSRF_HEADER]: 'e2e',
    ...extra,
  });
  const nextIp = () => {
    ipSeq += 1;
    return `10.${String(block)}.${String(Math.floor(ipSeq / 250) % 256)}.${String((ipSeq % 250) + 1)}`;
  };
  const request: AdminE2e['request'] = (method, url, headers = {}, ip = nextIp(), payload) => {
    ips.add(ip);
    return app.inject({
      method,
      url,
      headers,
      remoteAddress: ip,
      ...(payload === undefined ? {} : { payload }),
    });
  };
  const harness: AdminE2e = {
    env,
    clock,
    logs,
    cookieName: adminSessionCookieName(env.NODE_ENV),
    allowlist,
    db: () => app.get(PrismaService).client,
    app: () => app,
    nextIp,
    trackNonce: (nonce) => nonces.add(nonce),
    trackAdmin: (admin) => {
      adminIds.push(admin.id);
      telegramIds.push(admin.telegramId);
    },
    newAdmin: async (role, opts = {}) => {
      const telegramId = BigInt(nextTestTelegramId());
      telegramIds.push(telegramId);
      if (opts.allowlisted ?? true) allowlist.push(telegramId);
      const admin = await app.get(PrismaService).client.adminUser.create({
        data: { telegramId, name: `E2E ${role}`, role, isActive: opts.active ?? true },
      });
      adminIds.push(admin.id);
      return admin;
    },
    spa,
    request,
    start: async (ip) => {
      const res = await request('POST', `${ADMIN_BASE}/start`, spa(), ip, {});
      if (res.statusCode !== 200) throw new Error(`start failed: ${String(res.statusCode)}`);
      const { nonce } = res.json<{ data: { nonce: string } }>().data;
      nonces.add(nonce);
      return nonce;
    },
    issue: (nonce, telegramId) =>
      app.get(AdminLoginService).issueCode({ nonce, telegramId, now: clock.now() }),
    verify: (nonce, code, ip) =>
      request('POST', `${ADMIN_BASE}/verify`, spa(), ip, { nonce, code }),
    login: async (admin) => {
      const nonce = await harness.start();
      const issued = await harness.issue(nonce, admin.telegramId);
      if (!issued.ok) throw new Error(`issueCode refused: ${issued.reason}`);
      const res = await harness.verify(nonce, issued.code);
      const name = harness.cookieName;
      const set = setCookies(res).find((c) => c.startsWith(`${name}=`));
      const token = set?.slice(name.length + 1).split(';')[0] ?? '';
      if (res.statusCode !== 200 || token === '') throw new Error('admin login failed');
      return { cookie: `${name}=${token}`, token, res };
    },
    onClose: (close) => {
      closers.push(close);
    },
    webhook: (update) =>
      app.inject({
        method: 'POST',
        url: WEBHOOK_PATH,
        headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
        payload: update,
      }),
    loginUser: async () => {
      const telegramId = BigInt(nextTestTelegramId());
      users.push(telegramId);
      const now = clock.now();
      await app.get(UsersService).ensureTelegramUser({ telegramId, firstName: 'User' }, { now });
      const otp = app.get(OtpLoginService);
      const { nonce } = await otp.start(now);
      const issued = await otp.issueCode({ nonce, telegramId, now });
      if (!issued.ok) throw new Error(`issueCode refused: ${issued.reason}`);
      const headers = { origin: env.WEB_URL, [CSRF_HEADER]: 'e2e' };
      const res = await request('POST', '/api/v1/auth/telegram/verify', headers, undefined, {
        nonce,
        code: issued.code,
      });
      const line = setCookies(res).find((c) => c.startsWith(`${ACCESS_COOKIE_NAME}=`)) ?? '';
      const access = line.slice(ACCESS_COOKIE_NAME.length + 1).split(';')[0] ?? '';
      if (res.statusCode !== 200 || access === '') throw new Error('user login failed');
      return access;
    },
  };
  return harness;
}
