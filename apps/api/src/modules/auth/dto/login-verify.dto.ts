import { loginVerifyBodySchema } from '@repo/shared';
import { createZodDto } from 'nestjs-zod';

export class LoginVerifyDto extends createZodDto(loginVerifyBodySchema) {}
