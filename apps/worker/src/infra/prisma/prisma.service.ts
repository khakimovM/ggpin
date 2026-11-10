import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { assertProductionDatabase, createPrismaClient, type PrismaClient } from '@repo/db';
import { WORKER_CONFIG, type WorkerConfig } from '../../config/config.module';

// Repositories are the only consumers (rules/20-database-prisma.md): they use `prisma.client`.
// Composition instead of `extends PrismaClient`: the one client is built by @repo/db, which owns
// the driver adapter. The connection is lazy (pg connects on the first query), so booting a
// module graph in unit tests needs no database.
@Injectable()
export class PrismaService implements OnModuleInit, OnApplicationShutdown {
  readonly client: PrismaClient;
  private readonly production: boolean;

  constructor(@Inject(WORKER_CONFIG) config: WorkerConfig) {
    this.client = createPrismaClient(config.DATABASE_URL);
    this.production = config.NODE_ENV === 'production';
  }

  // D-52 r2 (symmetric to the dev-tool guard): a production process refuses to boot on a database
  // named *_dev / *_test or carrying the dev marker ggpin.env = dev, so a production container
  // pointed at a dev/test database (or the reverse mix-up) fails loudly at boot. Only production
  // connects here; dev and test keep the lazy connection.
  async onModuleInit(): Promise<void> {
    if (this.production) await assertProductionDatabase(this.client);
  }

  // onApplicationShutdown, not onModuleDestroy: Nest calls onModuleDestroy FIRST, while the HTTP
  // server may still be finishing a request that needs the database. onApplicationShutdown runs
  // after the server has stopped and after every beforeApplicationShutdown.
  //
  // This hook alone does NOT make BullMQ workers drain first: @nestjs/bullmq closes them in ITS
  // onApplicationShutdown, and hooks of one phase are not ordered against each other (the probe
  // showed this disconnect running first). BullWorkersShutdown (infra/queue) closes the workers
  // in beforeApplicationShutdown instead; queue-shutdown.e2e-spec.ts proves the order.
  async onApplicationShutdown(): Promise<void> {
    await this.client.$disconnect();
  }
}
