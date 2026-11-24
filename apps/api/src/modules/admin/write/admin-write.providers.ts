import type { Provider, Type } from '@nestjs/common';
import { CardPauseRepository } from '../../payments/card-pause.repository';
import { CardPauseService } from '../../payments/card-pause.service';
import { ReviewCreditService } from '../../payments/review-credit.service';
import { ReviewEffects } from '../../payments/review-effects';
import { WalletUnfreezeService } from '../../wallet/wallet-unfreeze.service';
import { AdminAccountsWriteController } from '../admins/admin-accounts-write.controller';
import { AdminAccountsWriteReplays } from '../admins/admin-accounts-write.replays';
import { AdminPanelAccountsService } from '../admins/admin-panel-accounts.service';
import { AdminCatalogWriteController } from '../catalog/admin-catalog-write.controller';
import { AdminCatalogWriteReplays } from '../catalog/admin-catalog-write.replays';
import { AdminCatalogWriteRepository } from '../catalog/admin-catalog-write.repository';
import { AdminCatalogWriteService } from '../catalog/admin-catalog-write.service';
import { AdminConfirmAdminsView } from '../confirm/admin-confirm-admins.view';
import { AdminConfirmController } from '../confirm/admin-confirm.controller';
import { AdminConfirmService } from '../confirm/admin-confirm.service';
import { AdminOtpIssuer } from '../confirm/admin-otp.issuer';
import { AdminOtpVerifier } from '../confirm/admin-otp.verifier';
import { AdminPaymentActionsController } from '../payments/admin-payment-actions.controller';
import { AdminPaymentActionsService } from '../payments/admin-payment-actions.service';
import { AdminUserActionsController } from '../users/admin-user-actions.controller';
import { AdminUserActionsRepository } from '../users/admin-user-actions.repository';
import { AdminUserActionsService } from '../users/admin-user-actions.service';
import { AdminWriteVoidController } from './admin-write-void.controller';
import { AdminWriteVoidService } from './admin-write-void.service';
import { AdminWriteReplays } from './admin-write.replays';
import { AdminWriteRepository } from './admin-write.repository';
import { AdminWriteRunner } from './admin-write.runner';

// The money and account writes of the admin panel (phase 9 S6): the step-up codes, the users'
// and the P2P routes. The owner CLI's services run behind them with an ADMIN actor. Classes another
// API module already provides (WalletRepository, OwnerOtpVerifier, CardAdminService,
// PaymentsAlerts) come from its exports, never a second instance; the rest exist only here.

export const ADMIN_WRITE_CONTROLLERS: Type[] = [
  AdminConfirmController,
  AdminUserActionsController,
  AdminPaymentActionsController,
  // S8a: the catalog writes (docs/04 «Katalog»).
  AdminCatalogWriteController,
  // S9a: the admin management (docs/04 «Adminlar»).
  AdminAccountsWriteController,
  // 9-B SA-1: voiding an Idempotency-Key (docs/04 «Kalitni bekor qilish»).
  AdminWriteVoidController,
];

export const ADMIN_WRITE_PROVIDERS: Provider[] = [
  AdminOtpIssuer,
  AdminOtpVerifier,
  AdminConfirmService,
  AdminWriteRepository,
  AdminWriteRunner,
  AdminWriteVoidService,
  AdminWriteReplays,
  AdminUserActionsRepository,
  AdminUserActionsService,
  AdminPaymentActionsService,
  AdminCatalogWriteRepository,
  AdminCatalogWriteService,
  AdminCatalogWriteReplays,
  AdminConfirmAdminsView,
  AdminPanelAccountsService,
  AdminAccountsWriteReplays,
  // The owner CLI's services that no other API module provides (cli/ops-cli.module.ts wires them too).
  CardPauseRepository,
  CardPauseService,
  ReviewCreditService,
  ReviewEffects,
  WalletUnfreezeService,
];
