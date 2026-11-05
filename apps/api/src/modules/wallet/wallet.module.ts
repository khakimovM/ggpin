import { Module } from '@nestjs/common';
import { WalletAdminService } from './wallet-admin.service';
import { WalletCache } from './wallet-cache';
import { WalletFrozenAlert } from './wallet-frozen-alert';
import { WalletController } from './wallet.controller';
import { WalletRepository } from './wallet.repository';
import { WalletService } from './wallet.service';

// Redis, Clock, Prisma, config and the queues come from global modules. The admin service is
// exported for the owner CLI (phase 4 S8); it has no controller.
//
// SECURITY: WalletAdminService does NO role check of its own. Call it only from the owner CLI
// (a process the operator starts on the server) or from a handler behind an OWNER guard; never
// from a user-session route. It moves money and writes the AuditLog on the caller's word.
@Module({
  controllers: [WalletController],
  providers: [WalletRepository, WalletCache, WalletFrozenAlert, WalletService, WalletAdminService],
  exports: [WalletService, WalletAdminService, WalletCache],
})
export class WalletModule {}
