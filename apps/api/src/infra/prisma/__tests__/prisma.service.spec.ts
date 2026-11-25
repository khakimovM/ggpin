import { Test } from '@nestjs/testing';
import { DatabaseTimeZoneError, NonProductionDatabaseError } from '@repo/db';
import { AppConfigModule } from '../../../config/config.module';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import { PrismaModule } from '../prisma.module';
import { PrismaService } from '../prisma.service';

describe('PrismaService', () => {
  it('builds the client from config without connecting, and closes cleanly with no database', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule.forRoot(buildTestEnv()), PrismaModule],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get(PrismaService).client).toBeDefined();
    await expect(moduleRef.close()).resolves.toBeUndefined();
  });
});

// D-52 r2: production refuses a *_dev/*_test database or the dev marker at boot.
describe('PrismaService production database check', () => {
  // One stub answers both boot queries (the identity row and the session TimeZone).
  async function boot(
    nodeEnv: 'production' | 'test',
    name: string,
    marker: string | null,
    tz = 'UTC',
  ) {
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule.forRoot({ ...buildTestEnv(), NODE_ENV: nodeEnv }), PrismaModule],
    }).compile();
    const query = jest
      .spyOn(moduleRef.get(PrismaService).client, '$queryRaw')
      .mockResolvedValue([{ name, marker, tz }]);
    // A failed init is not closed: Nest's close() awaits the same rejected init. The client never
    // connected (the query is stubbed), so nothing is left open.
    try {
      await moduleRef.init();
    } catch (error: unknown) {
      return { error, queried: query.mock.calls.length };
    }
    await moduleRef.close();
    return { error: null, queried: query.mock.calls.length };
  }

  it('production boots on a plain database', async () => {
    await expect(boot('production', 'ggpin', null)).resolves.toEqual({ error: null, queried: 2 });
  });

  it.each([
    ['ggpin_test', null],
    ['ggpin_dev', null],
    ['ggpin', 'dev'],
  ])('production refuses database %s with marker %s', async (name, marker) => {
    const { error } = await boot('production', name, marker);
    expect(error).toBeInstanceOf(NonProductionDatabaseError);
  });

  it('production refuses a session whose TimeZone is not UTC (audit L1)', async () => {
    const { error } = await boot('production', 'ggpin', null, 'Asia/Tashkent');
    expect(error).toBeInstanceOf(DatabaseTimeZoneError);
  });

  it('outside production nothing is queried (the connection stays lazy)', async () => {
    await expect(boot('test', 'ggpin_test', null)).resolves.toEqual({ error: null, queried: 0 });
  });
});
