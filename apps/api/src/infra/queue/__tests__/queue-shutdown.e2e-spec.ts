import { randomUUID } from 'node:crypto';
import { getQueueToken, Processor, WorkerHost } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { QUEUES } from '@repo/shared';
import { Queue, type Job } from 'bullmq';
import { AppConfigModule } from '../../../config/config.module';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import { PrismaService } from '../../prisma/prisma.service';
import { QueueModule } from '../queue.module';

// Real BullMQ worker, real Redis (logical DB 15), real QueueModule and PrismaService. The
// stand-in in prisma-shutdown-order.spec.ts cannot catch the real defect: @nestjs/bullmq closes
// its workers in onApplicationShutdown, the same hook Prisma disconnects in, and Nest does not
// order those hooks by need (the re-audit probe saw Prisma go first). This spec fails if
// BullWorkersShutdown is removed from QueueModule.
//
// The dummy processor runs on the real tg-outbox queue name (the API will own that consumer),
// so the queue wiring matches production; only jobs of this run are ever removed.
const events: string[] = [];

let releaseJob: () => void = () => undefined;
let jobStarted: () => void = () => undefined;
const started = new Promise<void>((resolve) => {
  jobStarted = resolve;
});

@Processor(QUEUES.TG_OUTBOX)
class SlowProcessor extends WorkerHost {
  async process(): Promise<void> {
    jobStarted();
    // Still running when shutdown begins; finishes shortly after.
    await new Promise<void>((resolve) => {
      releaseJob = resolve;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    events.push('job.finished');
  }
}

describe('shutdown order with a real BullMQ worker', () => {
  const env = buildE2eEnv();

  it('drains the running job and closes the worker before Prisma disconnects', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule.forRoot(env), QueueModule],
      // PrismaService sits in the ROOT module here, nearer the root than the BullMQ module, which
      // is the arrangement where Nest runs its onApplicationShutdown first. (PrismaModule is
      // @Global today, which happens to sort it last; this spec must not depend on that.)
      providers: [PrismaService, SlowProcessor],
    }).compile();
    moduleRef.useLogger(false);
    await moduleRef.init();

    jest.spyOn(moduleRef.get(PrismaService).client, '$disconnect').mockImplementation(() => {
      events.push('prisma.$disconnect');
      return Promise.resolve();
    });
    const worker = moduleRef.get(SlowProcessor).worker;
    const close = worker.close.bind(worker);
    jest.spyOn(worker, 'close').mockImplementation(async (force?: boolean) => {
      await close(force);
      events.push('worker.closed');
    });

    const queue = moduleRef.get<Queue>(getQueueToken(QUEUES.TG_OUTBOX), { strict: false });
    const jobId = `shutdown-${randomUUID()}`;
    const job: Job = await queue.add('send', { n: 1 }, { jobId });
    await started; // the job is now running inside the worker

    const closing = moduleRef.close();
    releaseJob();
    await closing;

    const at = (name: string): number => events.indexOf(name);
    expect(at('prisma.$disconnect')).toBeGreaterThan(-1);
    // The running job was not abandoned: it finished, and the worker reported closed, first.
    expect(at('job.finished')).toBeGreaterThan(-1);
    expect(at('job.finished')).toBeLessThan(at('prisma.$disconnect'));
    expect(at('worker.closed')).toBeGreaterThan(-1);
    expect(at('worker.closed')).toBeLessThan(at('prisma.$disconnect'));

    // Cleanup on a fresh connection: the module's own queue is closed by now.
    const cleanup = new Queue(QUEUES.TG_OUTBOX, { connection: { url: env.REDIS_URL } });
    await (await cleanup.getJob(job.id ?? jobId))?.remove();
    await cleanup.close();
  });
});
