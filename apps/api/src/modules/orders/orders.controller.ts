import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type { CreateOrderResponse, OrderDetail, OrderDto } from '@repo/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { WithMeta } from '../../common/http/with-meta';
import { IdempotencyKey } from '../payments/idempotency-key.decorator';
import {
  CreateOrderBodyDto,
  OrderDetailQueryDto,
  OrderListQueryDto,
  OrderParamsDto,
} from './dto/orders.dto';
import { OrdersService } from './orders.service';

// Session routes of docs/04 "Buyurtmalar". Every answer is per user, so the default `no-store`
// stays (no @PublicCache). Cookie-session POSTs pass the global CsrfGuard (X-CSRF-Token + Origin,
// D-26); Mini App Bearer requests do not need it. `userId` only from the session; the per-user
// purchase limit lives in the service, the global per-IP throttle still applies.
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  create(
    @CurrentUser('id') userId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body() body: CreateOrderBodyDto,
  ): Promise<CreateOrderResponse> {
    return this.orders.create(userId, idempotencyKey, body);
  }

  @Get()
  list(
    @CurrentUser('id') userId: string,
    @Query() query: OrderListQueryDto,
  ): Promise<WithMeta<readonly OrderDto[]>> {
    return this.orders.list(userId, query);
  }

  @Get(':id')
  get(
    @CurrentUser('id') userId: string,
    @Param() params: OrderParamsDto,
    @Query() query: OrderDetailQueryDto,
  ): Promise<OrderDetail> {
    return this.orders.get(userId, params.id, query);
  }
}
