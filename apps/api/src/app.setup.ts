import { VersioningType } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { applyCors, applySecurityHeaders } from './common/http/security-headers';
import { setupSwagger } from './common/http/setup-swagger';
import { APP_CONFIG, type AppConfig } from './config/config.module';

// Shared by main.ts and tests, so the HTTP surface under test is exactly what ships.
// The DI-based part of the pipeline (validation, envelope, errors, rate limit) lives in
// HttpPipelineModule; this function does what only the underlying Fastify app can do.
export async function configureApp(app: NestFastifyApplication): Promise<void> {
  const config = app.get<AppConfig>(APP_CONFIG);
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await applySecurityHeaders(app, config);
  applyCors(app, config);
  if (config.SWAGGER_ENABLED) setupSwagger(app);
}
