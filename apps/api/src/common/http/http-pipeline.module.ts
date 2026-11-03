import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ZodValidationPipe } from 'nestjs-zod';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { DEFAULT_RATE_LIMIT, type RateLimit } from './http-limits';
import { ResponseEnvelopeInterceptor } from './response-envelope.interceptor';

/** Rate limits are keyed by the client's /64 for IPv6. */
export const IPV6_CLIENT_PREFIX = 64;

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
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [{ ...rateLimit }],
          // Explicit, though it is the library default: a client owns a whole /64, so without
          // grouping it could pick a fresh bucket per request. IPv4-mapped IPv6 (::ffff:a.b.c.d)
          // is read as the plain IPv4 address by the same normaliser.
          ipv6SubnetPrefix: IPV6_CLIENT_PREFIX,
        }),
      ],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }
}
