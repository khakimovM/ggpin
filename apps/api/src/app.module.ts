import { Module, type DynamicModule } from '@nestjs/common';
import type { RateLimit } from './common/http/http-limits';
import { HttpPipelineModule } from './common/http/http-pipeline.module';
import { AppConfigModule, type AppConfig } from './config/config.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { QueueModule } from './infra/queue/queue.module';
import { RedisModule } from './infra/redis/redis.module';
import { HealthModule } from './modules/health/health.module';

export interface AppModuleOptions {
  /** Overrides the default per-IP limit; tests use a tiny window instead of 120 requests. */
  readonly rateLimit?: RateLimit;
}

@Module({})
export class AppModule {
  // Config is passed in (parsed in main.ts) so booting never depends on ambient process.env.
  static register(config: AppConfig, options: AppModuleOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        AppConfigModule.forRoot(config),
        HttpPipelineModule.register(options.rateLimit),
        PrismaModule,
        RedisModule,
        QueueModule,
        HealthModule,
      ],
    };
  }
}
