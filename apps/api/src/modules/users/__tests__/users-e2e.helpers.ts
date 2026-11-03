import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../../app.module';
import { configureApp } from '../../../app.setup';
import { createHttpAdapter } from '../../../common/http/create-http-adapter';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { UsersService } from '../users.service';

export interface UsersE2e {
  readonly now: Date;
  readonly users: UsersService;
  readonly db: PrismaService['client'];
  /** A fresh telegram id, remembered so afterAll removes exactly the rows this file created. */
  readonly newId: () => bigint;
  readonly counts: (telegramId: bigint) => Promise<{ users: number; wallets: number }>;
}

// Registers beforeAll/afterAll for the calling spec file: boots the real app on the `*_test`
// database and deletes this file's rows at the end. Telegram ids are built at runtime from the
// clock so reruns and parallel files never collide. Contains no test.
export function useUsersE2e(): UsersE2e {
  const env = buildE2eEnv();
  let app: NestFastifyApplication;
  let usersService: UsersService;
  let client: PrismaService['client'];
  let seq = 0;
  const createdTelegramIds: bigint[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(env)],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter(env), {
      logger: false,
    });
    await configureApp(app);
    await app.init();
    usersService = app.get(UsersService);
    client = app.get(PrismaService).client;
  });

  afterAll(async () => {
    const rows = await client.user.findMany({
      where: { telegramId: { in: createdTelegramIds } },
      select: { id: true },
    });
    const ids = rows.map((r) => r.id);
    await client.user.updateMany({ where: { id: { in: ids } }, data: { referredById: null } });
    await client.wallet.deleteMany({ where: { userId: { in: ids } } });
    await client.user.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  return {
    now: new Date('2026-06-01T12:00:00.000Z'),
    get users() {
      return usersService;
    },
    get db() {
      return client;
    },
    newId: () => {
      seq += 1;
      const id = BigInt(Date.now()) * 1_000n + BigInt(seq);
      createdTelegramIds.push(id);
      return id;
    },
    counts: async (telegramId) => ({
      users: await client.user.count({ where: { telegramId } }),
      wallets: await client.wallet.count({ where: { user: { telegramId } } }),
    }),
  };
}
