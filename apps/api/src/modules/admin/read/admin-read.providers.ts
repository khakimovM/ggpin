import type { Provider, Type } from '@nestjs/common';
import { BankFeedHealth } from '../../payments/bank-feed-health';
import { CARD_LOCK_TIMING, DEFAULT_CARD_LOCK_TIMING } from '../../payments/card-lock-timing';
import { CardPoolRepository } from '../../payments/card-pool.repository';
import { ReviewChecksRepository } from '../../payments/review-checks.repository';
import { ReviewCreditPreviewService } from '../../payments/review-credit-preview.service';
import { ReviewRepository } from '../../payments/review.repository';
import { AdminAccountsReadRepository } from '../admins/admin-accounts-read.repository';
import { AdminAccountsReadService } from '../admins/admin-accounts-read.service';
import { AdminAccountsController } from '../admins/admin-accounts.controller';
import { AdminAuditController } from '../audit/admin-audit.controller';
import { AdminAuditRepository } from '../audit/admin-audit.repository';
import { AdminAuditService } from '../audit/admin-audit.service';
import { AdminCatalogController } from '../catalog/admin-catalog.controller';
import { AdminCatalogReadRepository } from '../catalog/admin-catalog-read.repository';
import { AdminCatalogReadService } from '../catalog/admin-catalog-read.service';
import { AdminDashboardAlerts } from '../dashboard/admin-dashboard-alerts';
import { AdminDashboardCache } from '../dashboard/admin-dashboard.cache';
import { AdminDashboardController } from '../dashboard/admin-dashboard.controller';
import { AdminDashboardRepository } from '../dashboard/admin-dashboard.repository';
import { AdminDashboardService } from '../dashboard/admin-dashboard.service';
import { AdminInfraController } from '../infra/admin-infra.controller';
import { AdminQueuesReader } from '../infra/admin-queues.reader';
import { AdminOrderRowsRepository } from '../orders/admin-order-rows.repository';
import { AdminPaymentsController } from '../payments/admin-payments.controller';
import { AdminPaymentsReadRepository } from '../payments/admin-payments-read.repository';
import { AdminPaymentsReadService } from '../payments/admin-payments-read.service';
import { AdminFxReadRepository } from '../settings/admin-fx-read.repository';
import { AdminSettingsController } from '../settings/admin-settings.controller';
import { AdminSettingsService } from '../settings/admin-settings.service';
import { AdminUsersController } from '../users/admin-users.controller';
import { AdminUsersReadRepository } from '../users/admin-users-read.repository';
import { AdminUsersReadService } from '../users/admin-users-read.service';
import { AdminBalancesRepository } from './admin-balances.repository';

// The read side of the admin panel (phase 9 S4). AdminModule spreads these in (with WalletModule
// for the balance cache and PricingModule for the price preview), so they share its guards,
// AdminThrottle and AdminUsersRepository.

export const ADMIN_READ_CONTROLLERS: Type[] = [
  AdminDashboardController,
  AdminUsersController,
  AdminPaymentsController,
  AdminAuditController,
  AdminAccountsController,
  AdminCatalogController,
  AdminSettingsController,
  AdminInfraController,
];

export const ADMIN_READ_PROVIDERS: Provider[] = [
  AdminBalancesRepository,
  AdminOrderRowsRepository,
  AdminUsersReadRepository,
  AdminUsersReadService,
  AdminPaymentsReadRepository,
  AdminPaymentsReadService,
  AdminAuditRepository,
  AdminAuditService,
  AdminAccountsReadRepository,
  AdminAccountsReadService,
  AdminCatalogReadRepository,
  AdminCatalogReadService,
  AdminFxReadRepository,
  AdminSettingsService,
  AdminQueuesReader,
  AdminDashboardRepository,
  AdminDashboardAlerts,
  AdminDashboardCache,
  AdminDashboardService,
  // The owner CLI's credit preview (review:credit), read only; the CLI module wires the same.
  ReviewCreditPreviewService,
  ReviewRepository,
  ReviewChecksRepository,
  CardPoolRepository,
  { provide: CARD_LOCK_TIMING, useValue: DEFAULT_CARD_LOCK_TIMING },
  BankFeedHealth,
];
