import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  // Application context only: the worker never opens an HTTP port (docs/02-ARCHITECTURE.md).
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();

  // Nothing holds the event loop open until BullMQ consumers arrive in phase 1; without this
  // timer the process would exit right after boot. Shutdown hooks still close the app and
  // exit on SIGINT/SIGTERM. Remove the timer together with the phase-1 queue change.
  setInterval(() => undefined, 60_000);

  new Logger('Worker').log('worker started (no queues registered yet)');
}

void bootstrap();
