import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ZodValidationPipe } from 'nestjs-zod';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { DEFAULT_RATE_LIMIT, type RateLimit } from './http-limits';
import { ResponseEnvelopeInterceptor } from './response-envelope.interceptor';

// Global request pipeline, registered through APP_* tokens so every provider here can use
// DI (Reflector, throttler storage) and a test module that imports AppModule gets exactly the
// shipped behaviour. Order at runtime: guard (rate limit) -> pipe (Zod) -> handler ->
// interceptor (envelope); the filter catches anything thrown along the way.
@Module({})
export class HttpPipelineModule {
  // Storage is in-memory: correct for a single API container. Before running more than one
  // replica, switch to a Redis storage so the limit is shared (tracked for the Redis slice).
  static register(rateLimit: RateLimit = DEFAULT_RATE_LIMIT): DynamicModule {
    return {
      module: HttpPipelineModule,
      imports: [ThrottlerModule.forRoot({ throttlers: [{ ...rateLimit }] })],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }
}
