import { PrismaService } from '../prisma.service';

/**
 * For e2e suites whose config says NODE_ENV=production but which still run on the *_test database
 * on purpose: the production database identity check (D-52 r2: a production process refuses
 * *_dev/*_test or dev-marked databases) is skipped for them, and only for them. The check itself
 * is proven in infra/prisma/__tests__/prisma.service.spec.ts and
 * packages/db/test/database-identity.e2e.test.ts.
 */
export class TestDatabasePrismaService extends PrismaService {
  override onModuleInit(): Promise<void> {
    return Promise.resolve();
  }
}
