import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { Env } from './env';

// Inject with `@Inject(APP_CONFIG) private readonly config: AppConfig`. The value is parsed
// once in main.ts (fail fast, readable error) and passed in, so no provider re-reads
// process.env and tests supply their own object.
export const APP_CONFIG = Symbol('APP_CONFIG');
export type AppConfig = Env;

@Global()
@Module({})
export class AppConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
