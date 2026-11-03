import { loginStartBodySchema } from '@repo/shared';
import { createZodDto } from 'nestjs-zod';

export class LoginStartDto extends createZodDto(loginStartBodySchema) {}
