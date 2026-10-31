import helmet from '@fastify/helmet';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AppConfig } from '../../config/config.module';
import { corsOrigins } from './cors-origins';

export const SWAGGER_PATH = 'docs'; // served at /api/docs (global prefix)

// The API serves JSON only, so nothing may load or embed anything from it.
const API_CSP = { defaultSrc: ["'none'"], frameAncestors: ["'none'"] };

// Swagger UI ships its own scripts/styles from the same origin plus an inline <style>.
// Applied to /api/docs* only, and only when SWAGGER_ENABLED, so API responses keep the
// strict CSP above.
const DOCS_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join('; ');

export async function applySecurityHeaders(
  app: NestFastifyApplication,
  config: AppConfig,
): Promise<void> {
  // helmet also removes X-Powered-By and adds nosniff, no-referrer, HSTS, COOP/CORP.
  await app.register(helmet, {
    contentSecurityPolicy: { useDefaults: false, directives: API_CSP },
  });

  if (config.SWAGGER_ENABLED) {
    // Registered after helmet, so for docs requests this onRequest hook runs last and wins.
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onRequest', (request, reply, done) => {
        if (request.url.startsWith(`/api/${SWAGGER_PATH}`)) {
          void reply.header('content-security-policy', DOCS_CSP);
        }
        done();
      });
  }
}

// Credentialed CORS (cookie sessions) needs an explicit allowlist: a wildcard is invalid
// with credentials. A non-listed Origin simply gets no CORS headers, so the browser blocks
// the response; the server does not error.
export function applyCors(app: NestFastifyApplication, config: AppConfig): void {
  app.enableCors({
    origin: corsOrigins(config),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    // X-CSRF-Token is the CSRF header for state-changing cookie-session routes
    // (rules/60-security.md); the check itself arrives with auth in phase 2.
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-CSRF-Token'],
    exposedHeaders: ['Retry-After'],
    maxAge: 600,
  });
}
