import { Module, type DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { WorkerConfigModule, type WorkerConfig } from './config/config.module';
import { HeartbeatModule } from './heartbeat/heartbeat.module';
import { buildLoggerParams } from './logging/logger-params';
import { PrismaModule } from './infra/prisma/prisma.module';
import { QueueModule } from './infra/queue/queue.module';
import { RedisModule } from './infra/redis/redis.module';
import { roleModules } from './worker-role-modules';

export interface WorkerModuleOptions {
  /** Where log lines go instead of stdout; tests capture output here. */
  readonly logDestination?: DestinationStream;
}

// Every queue is registered as a producer in every role (QueueModule); a consumer exists only
// where its module is imported, and WORKER_ROLE decides that (worker-role-modules.ts, D-76).
// BullWorkersShutdown (QueueModule) drains all processors before Prisma and Redis disconnect,
// whichever module they live in.
@Module({})
export class WorkerModule {
  // Config is passed in (parsed in main.ts) so booting never depends on ambient process.env.
  static register(config: WorkerConfig, options: WorkerModuleOptions = {}): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        WorkerConfigModule.forRoot(config),
        LoggerModule.forRoot(buildLoggerParams(config, options.logDestination)),
        PrismaModule,
        RedisModule,
        QueueModule,
        HeartbeatModule.forRole(config.WORKER_ROLE),
        ...roleModules(config.WORKER_ROLE),
      ],
    };
  }
}
