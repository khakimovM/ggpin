import { Module, type DynamicModule } from '@nestjs/common';
import { workerRoleHeartbeatKeys, type WorkerRole } from '@repo/shared';
import { HEARTBEAT_KEYS, HeartbeatService } from './heartbeat.service';

// D-76: each role beats on its own process key (fulfillment `worker:heartbeat`, bankfeed
// `bankfeed:process-heartbeat`, all both), so one live container never hides a dead one.
@Module({})
export class HeartbeatModule {
  static forRole(role: WorkerRole): DynamicModule {
    return {
      module: HeartbeatModule,
      providers: [
        { provide: HEARTBEAT_KEYS, useValue: workerRoleHeartbeatKeys(role) },
        HeartbeatService,
      ],
    };
  }
}
