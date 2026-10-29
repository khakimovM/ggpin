import { Module, type DynamicModule } from '@nestjs/common';
import { AppConfigModule, type AppConfig } from './config/config.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { HealthModule } from './modules/health/health.module';

@Module({})
export class AppModule {
  // Config is passed in (parsed in main.ts) so booting never depends on ambient process.env.
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [AppConfigModule.forRoot(config), PrismaModule, HealthModule],
    };
  }
}
