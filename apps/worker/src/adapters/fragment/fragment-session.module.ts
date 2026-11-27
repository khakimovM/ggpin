import { Module } from '@nestjs/common';
import { WORKER_CONFIG, type WorkerConfig } from '../../config/config.module';
import { AdaptersModule } from '../adapters.module';
import { FRAGMENT_PAGE_SCRIPT, buildFragmentProbe } from './fragment-factories';
import { FragmentKeepaliveProcessor } from './fragment-keepalive.processor';
import { FragmentKeepaliveScheduler } from './fragment-keepalive.scheduler';
import { FRAGMENT_PROBE, FragmentKeepaliveService } from './fragment-keepalive.service';
import { FragmentNotifier } from './fragment-notifier';
import { FragmentPageScript } from './fragment-probe';
import { FRAGMENT_SESSION_KEY, FragmentSessionStore } from './fragment-session.store';

// The Fragment session (phase 5 S7): the encrypted cookie jar, the keep-alive (scheduler +
// consumer) and its probe. The health it writes is read by the adapters (FragmentHealth lives in
// AdaptersModule, next to the router whose cached health the keep-alive drops on a change).
@Module({
  imports: [AdaptersModule],
  providers: [
    {
      provide: FRAGMENT_SESSION_KEY,
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig) => config.FRAGMENT_SESSION_ENC_KEY,
    },
    FragmentSessionStore,
    { provide: FRAGMENT_PAGE_SCRIPT, useFactory: () => new FragmentPageScript() },
    {
      provide: FRAGMENT_PROBE,
      inject: [WORKER_CONFIG, FragmentSessionStore, FRAGMENT_PAGE_SCRIPT],
      useFactory: buildFragmentProbe,
    },
    FragmentNotifier,
    FragmentKeepaliveService,
    FragmentKeepaliveScheduler,
    FragmentKeepaliveProcessor,
  ],
  exports: [FragmentKeepaliveService, FRAGMENT_PAGE_SCRIPT],
})
export class FragmentSessionModule {}
