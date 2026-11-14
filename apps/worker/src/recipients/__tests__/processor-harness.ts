import type { RecipientCheckResult } from '@repo/shared';
import type { FulfillmentAdapter } from '../../adapters/fulfillment-adapter';
import { AdapterRouter } from '../../fulfillment/adapter-router';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { RecipientCheckTiming } from '../recipient-check.config';
import { RecipientLookupService } from '../recipient-lookup.service';
import type {
  RecipientCheckProduct,
  RecipientProductRepository,
} from '../recipient-product.repository';
import { ValidateRecipientProcessor } from '../validate-recipient.processor';
import { TG_USERNAME_FORM, stubAdapter } from './recipient-test-doubles';

// The processor and its lookup with the database and the router's routes faked (no Redis, no
// Postgres), for the unit specs. The e2e suites run the same code inside a real BullMQ Worker.

export const PRODUCT_ID = 'cmprod0000000000000000001';
export const TIMING: RecipientCheckTiming = {
  waitMs: 1_000,
  replyMarginMs: 100,
  minCallMs: 50,
  sweepEveryMs: 1_000,
  retentionMs: 1_000,
};
export const FOUND: RecipientCheckResult = {
  status: 'FOUND',
  providerRef: 'ref-1',
  displayName: 'Someone',
};

export interface Setup {
  readonly product?: RecipientCheckProduct | null;
  readonly routes?: readonly string[];
  readonly adapters?: readonly FulfillmentAdapter[];
}

export function build(setup: Setup = {}) {
  const product =
    setup.product === undefined
      ? { id: PRODUCT_ID, slug: 'stars', isActive: true, inputSchema: TG_USERNAME_FORM }
      : setup.product;
  const find = jest.fn(() => Promise.resolve(product));
  const products = { find } as unknown as RecipientProductRepository;
  const routes = setup.routes ?? ['FRAGMENT'];
  const findMany = jest.fn(() => Promise.resolve(routes.map((adapter) => ({ adapter }))));
  const prisma = { client: { productRoute: { findMany } } } as unknown as PrismaService;
  const adapters = setup.adapters ?? [
    stubAdapter('FRAGMENT', { validate: () => Promise.resolve(FOUND) }),
  ];
  const router = new AdapterRouter(prisma, new Map(adapters.map((a) => [a.code, a])));
  router['logger'].warn = jest.fn();
  const processor = new ValidateRecipientProcessor(
    new RecipientLookupService(products, router),
    TIMING,
  );
  const logs: string[] = [];
  const logger = processor['logger'];
  for (const level of ['log', 'warn', 'error'] as const) {
    logger[level] = jest.fn((message: unknown) => {
      logs.push(String(message));
    });
  }
  return { processor, find, findMany, logs };
}

export const job = (data: unknown, timestamp = Date.now()) => ({ data, timestamp });
export const request = (username = '@Aziz_K') => ({ productId: PRODUCT_ID, input: { username } });
