import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '@repo/shared';
import type { Queue } from 'bullmq';

// A BullMQ Queue with no 'error' listener dumps every Redis reconnect failure to
// console.error. Log each distinct reason once per queue through the Nest logger instead.
// Messages are ioredis/BullMQ errors (host:port + reason), never the connection URL.
@Injectable()
export class QueueErrorLogger implements OnModuleInit {
  private readonly logger = new Logger('Queue');
  private readonly lastError = new Map<string, string>();

  constructor(private readonly moduleRef: ModuleRef) {}

  onModuleInit(): void {
    for (const name of QUEUE_NAMES) {
      const queue = this.moduleRef.get<Queue>(getQueueToken(name), { strict: false });
      queue.on('error', (error: Error) => {
        if (this.lastError.get(name) === error.message) return;
        this.lastError.set(name, error.message);
        this.logger.warn(`queue ${name}: ${error.message}`);
      });
    }
  }
}
