import { updateMeBodySchema } from '@repo/shared';
import { createZodDto } from 'nestjs-zod';

export class UpdateMeDto extends createZodDto(updateMeBodySchema) {}
