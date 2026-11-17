import { AdminLoginVerifyBodySchema } from '@repo/shared';
import { createZodDto } from 'nestjs-zod';

export class AdminLoginVerifyDto extends createZodDto(AdminLoginVerifyBodySchema) {}
