import fastifyCookie from '@fastify/cookie';
import { VersioningType } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { registerRequestHooks } from './common/logging/request-logging';
import { applyCachePolicy } from './common/http/cache-policy';
import { applyCors, applySecurityHeaders } from './common/http/security-headers';
import { setupSwagger } from './common/http/setup-swagger';
import { APP_CONFIG, type AppConfig } from './config/config.module';

// Shared by main.ts and tests, so the HTTP surface under test is exactly what ships.
// The DI-based part of the pipeline (validation, envelope, errors, rate limit) lives in
// HttpPipelineModule; this function does what only the underlying Fastify app can do.
export async function configureApp(app: NestFastifyApplication): Promise<void> {
  const config = app.get<AppConfig>(APP_CONFIG);
  // Pairs with bufferLogs in main.ts: logs written while the app was being built are replayed
  // through Pino, so boot output is structured and redacted like everything else.
  app.useLogger(app.get(Logger));
  registerRequestHooks(app);
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await applySecurityHeaders(app, config);
  applyCors(app, config);
  // After helmet and CORS so preflights and security headers are already settled when a request
  // reaches cookie parsing. Deliberately no `secret`: session cookies carry self-authenticating
  // tokens (HMAC-signed access token / hashed-in-DB refresh), so cookie signing adds nothing.
  // Cookies are host-only (no Domain), set per response by the auth module; CSRF is the
  // X-CSRF-Token header plus the Origin allowlist (D-26).
  await app.register(fastifyCookie);
  // After the cookie plugin: onSend hooks run in registration order, and @fastify/cookie writes
  // reply.setCookie() values in its own onSend. Registered earlier, the policy would not see
  // those Set-Cookie headers and could mark a per-user response publicly cacheable.
  applyCachePolicy(app);
  if (config.SWAGGER_ENABLED) setupSwagger(app);
}
