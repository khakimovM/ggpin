import { Inject, Injectable } from '@nestjs/common';
import {
  ORDER_ADMIN_LIST_DEFAULT_LIMIT,
  ORDER_ADMIN_LIST_MAX_LIMIT,
  orderStatusSchema,
  type OrderStatus,
} from '@repo/shared';
import { checkedId, validationError } from '../../../common/admin/admin-input';
import { AppError } from '../../../common/exceptions/app-error';
import {
  OrderAdminRepository,
  type AuditRow,
  type LedgerRow,
  type OrderDetailRow,
  type OrderListRow,
} from './order-admin.repository';
import { OPERATOR_CHANNEL, assertOwnerChannel, type OperatorChannel } from './operator-channel';

export interface OrderShow {
  readonly order: OrderDetailRow;
  readonly ledger: readonly LedgerRow[];
  readonly audits: readonly AuditRow[];
}

/** `order:list` and `order:show` (read only; no recipient, provider handle or cost is selected). */
@Injectable()
export class OrderAdminReadService {
  constructor(
    private readonly repo: OrderAdminRepository,
    @Inject(OPERATOR_CHANNEL) private readonly channel: OperatorChannel,
  ) {}

  list(status: string | undefined, limit: number | undefined): Promise<OrderListRow[]> {
    assertOwnerChannel(this.channel);
    let parsedStatus: OrderStatus | undefined;
    if (status !== undefined) {
      const parsed = orderStatusSchema.safeParse(status);
      if (!parsed.success) throw validationError('status');
      parsedStatus = parsed.data;
    }
    const take = limit ?? ORDER_ADMIN_LIST_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(take) || take < 1 || take > ORDER_ADMIN_LIST_MAX_LIMIT) {
      throw validationError('limit');
    }
    return this.repo.list(parsedStatus, take);
  }

  async show(orderId: string): Promise<OrderShow> {
    assertOwnerChannel(this.channel);
    const id = checkedId('orderId', orderId);
    const order = await this.repo.detail(id);
    if (order === null) throw new AppError('NOT_FOUND');
    const [ledger, audits] = await Promise.all([this.repo.ledger(id), this.repo.audits(id)]);
    return { order, ledger, audits };
  }
}
