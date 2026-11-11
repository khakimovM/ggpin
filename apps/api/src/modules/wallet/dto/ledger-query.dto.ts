import { LedgerQuerySchema } from '@repo/shared';
import { createZodDto } from 'nestjs-zod';

export class LedgerQueryDto extends createZodDto(LedgerQuerySchema) {}
