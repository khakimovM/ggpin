import { Module, type DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { WorkerConfigModule, type WorkerConfig } from './config/config.module';
import { HeartbeatModule } from './heartbeat/heartbeat.module';
import { buildLoggerParams } from './logging/logger-params';
import { PrismaModule } from './infra/prisma/prisma.module';
import { QueueModule } from './infra/queue/queue.module';
import { RedisModule } from './infra/redis/redis.module';

export interface WorkerModuleOptions {
  /** Where log lines go instead of stdout; tests capture output here. */
  readonly logDestination?: DestinationStream;
}

// Queue processors (fulfill-order, validate-recipient, price-sync, ...) are added by their
// phases (docs/02-ARCHITECTURE.md#worker-modullari); the queues themselves are registered now.
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
        HeartbeatModule,
      ],
    };
  }
}
