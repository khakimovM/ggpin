import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { createHttpAdapter } from './common/http/create-http-adapter';
import { EnvValidationError, loadEnv, type Env } from './config/env';

// Misconfiguration must stop the process with a readable reason, not a stack trace.
function loadEnvOrExit(): Env {
  try {
    return loadEnv();
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
  await app.listen(env.API_PORT, '0.0.0.0');
}

void bootstrap();
