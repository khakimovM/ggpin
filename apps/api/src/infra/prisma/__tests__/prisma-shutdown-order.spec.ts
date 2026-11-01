import {
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppConfigModule } from '../../../config/config.module';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import { PrismaModule } from '../prisma.module';
import { PrismaService } from '../prisma.service';

const calls: string[] = [];

// Records every lifecycle phase Nest drives. This only proves the Nest hook phases: a stand-in
// cannot show how BullMQ workers are ordered, so that is covered with a real BullMQ worker and
// Redis in queue/__tests__/queue-shutdown.e2e-spec.ts.
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
      imports: [AppConfigModule.forRoot(buildTestEnv()), PrismaModule],
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
