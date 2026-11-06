import {
  CancelTopupIntentBodySchema,
  CreateTopupIntentBodySchema,
  IntentListQuerySchema,
  IntentParamsSchema,
  PayLinkBodySchema,
} from '@repo/shared';
import { createZodDto } from 'nestjs-zod';

export class CreateTopupIntentBodyDto extends createZodDto(CreateTopupIntentBodySchema) {}
export class IntentListQueryDto extends createZodDto(IntentListQuerySchema) {}
export class IntentParamsDto extends createZodDto(IntentParamsSchema) {}
export class CancelTopupIntentBodyDto extends createZodDto(CancelTopupIntentBodySchema) {}
export class PayLinkBodyDto extends createZodDto(PayLinkBodySchema) {}
