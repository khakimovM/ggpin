import {
  AdminAdjustWalletBodySchema,
  AdminCardLimitBodySchema,
  AdminCardPauseBodySchema,
  AdminCardResumeBodySchema,
  AdminCardRetireBodySchema,
  AdminNoteBodySchema,
  AdminPaymentReverseBodySchema,
  AdminReasonBodySchema,
  AdminReviewCreditBodySchema,
  AdminWriteKeyVoidBodySchema,
} from '@repo/shared';
import { createZodDto } from 'nestjs-zod';

// Bodies of the admin write routes of S6 (the shared strict Zod schemas), validated by the global
// ZodValidationPipe after the admin guards (docs/04: shape errors only for a live session).
export class AdminReasonBodyDto extends createZodDto(AdminReasonBodySchema) {}
export class AdminNoteBodyDto extends createZodDto(AdminNoteBodySchema) {}
export class AdminAdjustWalletBodyDto extends createZodDto(AdminAdjustWalletBodySchema) {}
export class AdminReviewCreditBodyDto extends createZodDto(AdminReviewCreditBodySchema) {}
export class AdminPaymentReverseBodyDto extends createZodDto(AdminPaymentReverseBodySchema) {}
export class AdminCardPauseBodyDto extends createZodDto(AdminCardPauseBodySchema) {}
export class AdminCardResumeBodyDto extends createZodDto(AdminCardResumeBodySchema) {}
export class AdminCardLimitBodyDto extends createZodDto(AdminCardLimitBodySchema) {}
export class AdminCardRetireBodyDto extends createZodDto(AdminCardRetireBodySchema) {}
export class AdminWriteKeyVoidBodyDto extends createZodDto(AdminWriteKeyVoidBodySchema) {}
