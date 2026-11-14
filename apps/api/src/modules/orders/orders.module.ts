import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { WalletModule } from '../wallet/wallet.module';
import { OrderEffects } from './order-effects';
import { OrdersController } from './orders.controller';
import { OrdersRepository } from './orders.repository';
import { OrdersService } from './orders.service';

// Prisma, Redis (FixedWindowCounter), Clock and the queues (FulfillOrderEnqueuer) come from
// global modules. WalletModule gives the balance cache, NotificationsModule the order notices.
@Module({
  imports: [WalletModule, NotificationsModule],
  controllers: [OrdersController],
  providers: [OrdersRepository, OrderEffects, OrdersService],
})
export class OrdersModule {}
