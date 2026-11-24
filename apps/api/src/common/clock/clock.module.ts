import { Global, Module } from '@nestjs/common';
import { MONOTONIC_CLOCK, performanceClock } from '../admin/admin-deadline';
import { CLOCK, systemClock } from './clock';

// Global so any service can `@Inject(CLOCK)`; tests override the provider with a fixed clock.
// MONOTONIC_CLOCK measures an admin write's deadline (performance.now(); tests add an offset).
@Global()
@Module({
  providers: [
    { provide: CLOCK, useValue: systemClock },
    { provide: MONOTONIC_CLOCK, useValue: performanceClock },
  ],
  exports: [CLOCK, MONOTONIC_CLOCK],
})
export class ClockModule {}
