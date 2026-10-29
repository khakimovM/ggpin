import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@repo/db';
import { WORKER_CONFIG, type WorkerConfig } from '../../config/config.module';

// Repositories are the only consumers (rules/20-database-prisma.md): they use `prisma.client`.
// Composition instead of `extends PrismaClient`: the one client is built by @repo/db, which owns
// the driver adapter. The connection is lazy (pg connects on the first query), so booting a
// module graph in unit tests needs no database.
@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(WORKER_CONFIG) config: WorkerConfig) {
    this.client = createPrismaClient(config.DATABASE_URL);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
