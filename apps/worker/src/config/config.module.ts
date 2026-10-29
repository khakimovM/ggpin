import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { Env } from './env';

// Inject with `@Inject(WORKER_CONFIG) private readonly config: WorkerConfig`. Parsed once in
// main.ts (fail fast, readable error) and passed in, so tests supply their own object.
export const WORKER_CONFIG = Symbol('WORKER_CONFIG');
export type WorkerConfig = Env;

@Global()
@Module({})
export class WorkerConfigModule {
  static forRoot(config: WorkerConfig): DynamicModule {
    return {
      module: WorkerConfigModule,
      providers: [{ provide: WORKER_CONFIG, useValue: config }],
      exports: [WORKER_CONFIG],
    };
  }
}
