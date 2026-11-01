import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { BRAND } from '@repo/shared';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { SWAGGER_PATH } from './security-headers';

// Off unless SWAGGER_ENABLED=true; the caller checks the flag (default false). The flag is not
// the only gate: env.ts refuses to boot with it enabled when NODE_ENV=production, so the API
// docs can never be published there.
export function setupSwagger(app: NestFastifyApplication): void {
  const options = new DocumentBuilder().setTitle(`${BRAND.name} API`).setVersion('1').build();
  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, options));
  SwaggerModule.setup(SWAGGER_PATH, app, document, { useGlobalPrefix: true });
}
