import { Injectable, type BeforeApplicationShutdown } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { WorkerHost } from '@nestjs/bullmq';

interface Closable {
  close(): Promise<void>;
}

// Duck-typed on purpose: an `instanceof Worker` check would silently skip draining if two copies
// of bullmq ever ended up in the install tree.
const isClosable = (value: unknown): value is Closable =>
  typeof value === 'object' &&
  value !== null &&
  'close' in value &&
  typeof value.close === 'function';

/**
 * Drains every BullMQ worker the app registered BEFORE Nest starts `onApplicationShutdown`.
 *
 * Why: @nestjs/bullmq closes its workers in its own `onApplicationShutdown`, the very hook
 * PrismaService and RedisService use to disconnect. Nest orders those hooks by module graph,
 * not by need, and the re-audit probe showed Prisma disconnecting FIRST, so a job still
 * running at SIGTERM lost its database (and, for a money job, could be left half-done).
 * `beforeApplicationShutdown` runs strictly before every `onApplicationShutdown`, so closing
 * the workers here guarantees: workers finish their current job (`Worker.close()` waits for it)
 * -> then Prisma and Redis disconnect.
 *
 * Workers are found through the processors' `WorkerHost` instances (the same objects
 * BullExplorer builds the workers for), so a processor added in any module is covered without
 * registering it here. Closing twice is harmless: BullMQ returns the same closing promise.
 */
@Injectable()
export class BullWorkersShutdown implements BeforeApplicationShutdown {
  constructor(private readonly discovery: DiscoveryService) {}

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers().map((worker) => worker.close()));
  }

  private workers(): Closable[] {
    const workers: Closable[] = [];
    for (const wrapper of this.discovery.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (!(instance instanceof WorkerHost)) continue;
      try {
        const worker: unknown = instance.worker;
        if (isClosable(worker)) workers.push(worker);
      } catch {
        // `worker` throws until BullExplorer has created it; nothing to drain yet.
      }
    }
    return workers;
  }
}
