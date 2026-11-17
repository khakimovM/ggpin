import { AdminLoginStartBodySchema } from '@repo/shared';
import { createZodDto } from 'nestjs-zod';

export class AdminLoginStartDto extends createZodDto(AdminLoginStartBodySchema) {}
