import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { BRAND } from '@repo/shared';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { SWAGGER_PATH } from './security-headers';

// Off unless SWAGGER_ENABLED=true; the caller checks the flag. env.ts has no production
// override, so the flag is the only gate (default false in every environment).
export function setupSwagger(app: NestFastifyApplication): void {
  const options = new DocumentBuilder().setTitle(`${BRAND.name} API`).setVersion('1').build();
  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, options));
  SwaggerModule.setup(SWAGGER_PATH, app, document, { useGlobalPrefix: true });
}
