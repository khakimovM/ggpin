import { webAppLoginBodySchema } from '@repo/shared';
import { createZodDto } from 'nestjs-zod';

export class WebAppLoginDto extends createZodDto(webAppLoginBodySchema) {}
