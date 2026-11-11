import { Module } from '@nestjs/common';
import { OwnerOtpVerifier } from '../../common/admin/owner-otp/owner-otp.verifier';
import { WalletAdminService } from './wallet-admin.service';
import { WalletCache } from './wallet-cache';
import { WalletFrozenAlert } from './wallet-frozen-alert';
import { WalletController } from './wallet.controller';
import { WalletRepository } from './wallet.repository';
import { WalletService } from './wallet.service';

// Redis, Clock, Prisma, config and the queues come from global modules. The admin service has no
// controller and no route. The owner CLI does NOT use this module: it registers its own providers
// (cli/ops-cli.module.ts). The service is exported here only so the API e2e suites can reach it.
//
// SECURITY: WalletAdminService does NO role check of its own. Call it only from the owner CLI
// (a process the operator starts on the server) or from a handler behind an OWNER guard; never
// from a user-session route. It moves money and writes the AuditLog on the caller's word.
@Module({
  controllers: [WalletController],
  providers: [
    WalletRepository,
    WalletCache,
    WalletFrozenAlert,
    WalletService,
    WalletAdminService,
    // Checks the owner's code of a money action above the threshold (D-46); Redis only.
    OwnerOtpVerifier,
  ],
  exports: [WalletService, WalletAdminService, WalletCache],
})
export class WalletModule {}
