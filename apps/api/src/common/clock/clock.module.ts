import { Global, Module } from '@nestjs/common';
import { CLOCK, systemClock } from './clock';

// Global so any service can `@Inject(CLOCK)`; tests override the provider with a fixed clock.
@Global()
@Module({ providers: [{ provide: CLOCK, useValue: systemClock }], exports: [CLOCK] })
export class ClockModule {}
