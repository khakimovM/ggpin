import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { scrubSecretsInText } from '@repo/shared';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { createHttpAdapter } from './common/http/create-http-adapter';
import { EnvValidationError, loadProcessEnv, type Env } from './config/env';
import { ownerAlertRecipientsLine } from './modules/notifications/owner-alert-recipients.log';

// Misconfiguration must stop the process with a readable reason, not a stack trace.
function loadEnvOrExit(): Env {
  try {
    return loadProcessEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

async function bootstrap(): Promise<void> {
  const env = loadEnvOrExit();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(env),
    createHttpAdapter(env),
    // Buffer until configureApp installs the Pino logger, so boot logs are structured too.
    { bufferLogs: true },
  );
  await configureApp(app);
  app.enableShutdownHooks();
  new Logger('Boot').log(ownerAlertRecipientsLine(env.OWNER_ALERT_CHAT_ID));
  await app.listen(env.API_PORT, '0.0.0.0');
}

// Node prints an unhandled rejection with util.inspect, nested properties included (a client
// error's request payload, a URL with a token). Only the scrubbed stack text is written.
bootstrap().catch((error: unknown) => {
  const text =
    error instanceof Error
      ? (error.stack ?? `${error.name}: ${error.message}`)
      : 'non-Error thrown';
  process.stderr.write(`boot failed: ${scrubSecretsInText(text)}\n`);
  process.exit(1);
});
