import { ValidateRecipientBodySchema } from '@repo/shared';
import { createZodDto } from 'nestjs-zod';

export class ValidateRecipientBodyDto extends createZodDto(ValidateRecipientBodySchema) {}
