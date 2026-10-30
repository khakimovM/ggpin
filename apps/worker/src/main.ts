import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { QUEUE_NAMES } from '@repo/shared';
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

  // No keep-alive timer: the BullMQ Redis connections and the heartbeat interval keep the
  // event loop busy; enableShutdownHooks closes them (and so lets the process exit) on
  // SIGINT/SIGTERM.
  new Logger('Worker').log(
    `worker started (${QUEUE_NAMES.length} queues registered, no processors yet, dryRun=${String(env.FULFILLMENT_DRY_RUN)}, ton=${env.TON_NETWORK})`,
  );
}

void bootstrap();
