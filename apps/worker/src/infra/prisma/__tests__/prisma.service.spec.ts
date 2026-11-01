import { Test } from '@nestjs/testing';
import { WorkerConfigModule } from '../../../config/config.module';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import { PrismaModule } from '../prisma.module';
import { PrismaService } from '../prisma.service';

describe('PrismaService', () => {
  it('builds the client from config without connecting, and closes cleanly with no database', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerConfigModule.forRoot(buildTestEnv()), PrismaModule],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get(PrismaService).client).toBeDefined();
    await expect(moduleRef.close()).resolves.toBeUndefined();
  });
});
