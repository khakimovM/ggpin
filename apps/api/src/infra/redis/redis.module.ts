import { Global, Module } from '@nestjs/common';
import { FixedWindowCounter } from './fixed-window-counter';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [RedisService, FixedWindowCounter],
  exports: [RedisService, FixedWindowCounter],
})
export class RedisModule {}
