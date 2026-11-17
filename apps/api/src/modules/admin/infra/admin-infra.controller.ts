import { Get } from '@nestjs/common';
import type { AdminInfraQueuesResponse } from '@repo/shared';
import { AdminAction } from '../common/admin-action.decorator';
import { AdminController } from '../common/admin-controller.decorator';
import { AdminQueuesReader } from './admin-queues.reader';

// `GET /api/v1/admin/infra/queues` (OWNER and OPERATOR, `infra.read`). The TON wallet, Fragment
// and adapter health reads join in 9-B with phase 5; the job retry (OWNER) is S6.
@AdminController('infra')
export class AdminInfraController {
  constructor(private readonly queues: AdminQueuesReader) {}

  @AdminAction('infra.read')
  @Get('queues')
  list(): Promise<AdminInfraQueuesResponse> {
    return this.queues.counts();
  }
}
