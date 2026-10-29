import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EnvValidationError, loadEnv, type Env } from './config/env';
import { WorkerModule } from './worker.module';

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
  // Application context only: the worker never opens an HTTP port (docs/02-ARCHITECTURE.md).
  const app = await NestFactory.createApplicationContext(WorkerModule.register(env));
  app.enableShutdownHooks();

  // Nothing holds the event loop open until BullMQ consumers arrive in phase 1; without this
  // timer the process would exit right after boot. Shutdown hooks still close the app and
  // exit on SIGINT/SIGTERM. Remove the timer together with the phase-1 queue change.
  setInterval(() => undefined, 60_000);

  new Logger('Worker').log(
    `worker started (no queues registered yet, dryRun=${String(env.FULFILLMENT_DRY_RUN)}, ton=${env.TON_NETWORK})`,
  );
}

void bootstrap();
