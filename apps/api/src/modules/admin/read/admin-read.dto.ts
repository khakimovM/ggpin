import {
  AdminAuditExportQuerySchema,
  AdminAuditListQuerySchema,
  AdminCreditPreviewQuerySchema,
  AdminDashboardQuerySchema,
  AdminFxHistoryQuerySchema,
  AdminIntentListQuerySchema,
  AdminPaymentListQuerySchema,
  AdminPricePreviewQuerySchema,
  AdminReconcileQuerySchema,
  AdminReviewListQuerySchema,
  AdminUserListQuerySchema,
  AdminUserTabQuerySchema,
} from '@repo/shared';
import { createZodDto } from 'nestjs-zod';

// Query DTOs of the admin read routes (phase 9 S4): the shared Zod schemas (strict objects,
// `limit` <= 100) run in the global ZodValidationPipe, after the admin guards, so a request
// without a session never learns what a valid query looks like (docs/04, SA-L5).
export class AdminDashboardQueryDto extends createZodDto(AdminDashboardQuerySchema) {}
export class AdminUserListQueryDto extends createZodDto(AdminUserListQuerySchema) {}
export class AdminUserTabQueryDto extends createZodDto(AdminUserTabQuerySchema) {}
export class AdminIntentListQueryDto extends createZodDto(AdminIntentListQuerySchema) {}
export class AdminPaymentListQueryDto extends createZodDto(AdminPaymentListQuerySchema) {}
export class AdminReviewListQueryDto extends createZodDto(AdminReviewListQuerySchema) {}
export class AdminCreditPreviewQueryDto extends createZodDto(AdminCreditPreviewQuerySchema) {}
export class AdminReconcileQueryDto extends createZodDto(AdminReconcileQuerySchema) {}
export class AdminAuditListQueryDto extends createZodDto(AdminAuditListQuerySchema) {}
export class AdminAuditExportQueryDto extends createZodDto(AdminAuditExportQuerySchema) {}
export class AdminPricePreviewQueryDto extends createZodDto(AdminPricePreviewQuerySchema) {}
export class AdminFxHistoryQueryDto extends createZodDto(AdminFxHistoryQuerySchema) {}
