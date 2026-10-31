import {
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WorkerConfigModule } from '../../../config/config.module';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import { PrismaModule } from '../prisma.module';
import { PrismaService } from '../prisma.service';

const calls: string[] = [];

// Stands in for "something that still needs the database while shutting down" (a BullMQ worker
// finishing a job, an in-flight request): it records every lifecycle phase Nest drives.
@Injectable()
class LifecycleRecorder
  implements OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown
{
  onModuleDestroy(): void {
    calls.push('onModuleDestroy');
  }
  beforeApplicationShutdown(): void {
    calls.push('beforeApplicationShutdown');
  }
  onApplicationShutdown(): void {
    calls.push('onApplicationShutdown');
  }
}

describe('PrismaService shutdown order', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('disconnects only after onModuleDestroy and beforeApplicationShutdown have run', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerConfigModule.forRoot(buildTestEnv()), PrismaModule],
      providers: [LifecycleRecorder],
    }).compile();
    await moduleRef.init();
    jest.spyOn(moduleRef.get(PrismaService).client, '$disconnect').mockImplementation(() => {
      calls.push('prisma.$disconnect');
      return Promise.resolve();
    });

    await moduleRef.close();

    const disconnectAt = calls.indexOf('prisma.$disconnect');
    expect(disconnectAt).toBeGreaterThan(-1);
    expect(calls.indexOf('onModuleDestroy')).toBeLessThan(disconnectAt);
    expect(calls.indexOf('beforeApplicationShutdown')).toBeLessThan(disconnectAt);
    expect(calls.filter((c) => c === 'prisma.$disconnect')).toHaveLength(1);
  });
});
