import { Test } from '@nestjs/testing';
import { AdaptersModule } from '../../adapters/adapters.module';
import { buildTestEnv } from '../../config/__tests__/test-env';
import { WorkerConfigModule, type WorkerConfig } from '../../config/config.module';
import { FULFILL_ADAPTERS, type AdapterRegistry } from '../../fulfillment/fulfill-tokens';
import { PrismaModule } from '../../infra/prisma/prisma.module';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RecipientLookupService } from '../recipient-lookup.service';
import { RecipientProductRepository } from '../recipient-product.repository';
import { TG_USERNAME_FORM } from './recipient-test-doubles';

// The production shape of validate-recipient (audit I-3): with NODE_ENV=production (even in a
// dry run) or FULFILLMENT_DRY_RUN=false the shared AdaptersModule holds NO adapter until the real
// ones land (S8), so a check is UNAVAILABLE (NO_ADAPTER) — never a simulator's answer — even when
// the product has a route. Real module wiring; only the database is faked.

const PRODUCT_ID = 'cmprod0000000000000000001';

async function lookupIn(config: WorkerConfig) {
  const product = { id: PRODUCT_ID, slug: 'stars', isActive: true, inputSchema: TG_USERNAME_FORM };
  const prisma = {
    client: {
      productRoute: { findMany: () => Promise.resolve([{ adapter: 'FRAGMENT' }]) },
    },
  };
  const moduleRef = await Test.createTestingModule({
    imports: [WorkerConfigModule.forRoot(config), PrismaModule, AdaptersModule],
    providers: [
      RecipientLookupService,
      { provide: RecipientProductRepository, useValue: { find: () => Promise.resolve(product) } },
    ],
  })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();
  moduleRef.useLogger(false);
  return {
    registry: moduleRef.get<AdapterRegistry>(FULFILL_ADAPTERS),
    lookup: moduleRef.get(RecipientLookupService),
    close: () => moduleRef.close(),
  };
}

describe('validate-recipient where real money could be meant', () => {
  it.each([
    ['NODE_ENV=production (dry run)', { ...buildTestEnv(), NODE_ENV: 'production' as const }],
    ['FULFILLMENT_DRY_RUN=false', { ...buildTestEnv(), FULFILLMENT_DRY_RUN: false }],
  ])('%s: no adapter, the check is UNAVAILABLE (NO_ADAPTER)', async (_, config) => {
    const { registry, lookup, close } = await lookupIn(config);
    try {
      expect(registry.size).toBe(0);
      const request = { productId: PRODUCT_ID, input: { username: 'aziz_k' } };
      await expect(lookup.check(request, 1_000, 50)).resolves.toEqual({
        kind: 'RESULT',
        result: { status: 'UNAVAILABLE' },
        reason: 'NO_ADAPTER',
        adapter: null,
      });
    } finally {
      await close();
    }
  });

  it('a non-production dry run has the simulators (the contrast)', async () => {
    const { registry, close } = await lookupIn(buildTestEnv());
    try {
      expect([...registry.keys()].sort()).toEqual(['FRAGMENT', 'RESELLER_STARS']);
    } finally {
      await close();
    }
  });
});
