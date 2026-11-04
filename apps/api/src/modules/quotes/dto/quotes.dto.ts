import { CreateQuoteBodySchema } from '@repo/shared';
import { createZodDto } from 'nestjs-zod';

export class CreateQuoteBodyDto extends createZodDto(CreateQuoteBodySchema) {}
