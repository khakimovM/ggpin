import type { Order, PaymentIntent, Prisma, Quote, User } from '../src/index';
import { db } from './client';

let counter = 0;
const next = (): number => ++counter;

export async function createUser(): Promise<User> {
  const n = next();
  return db.user.create({
    data: { telegramId: BigInt(1_000_000 + n), referralCode: `ref${n}-${Date.now()}` },
  });
}

export async function createQuote(
  userId: string,
  overrides: Partial<Prisma.QuoteUncheckedCreateInput> = {},
): Promise<Quote> {
  const n = next();
  const category = await db.category.create({
    data: { slug: `cat-${n}`, nameUz: 'Kategoriya', nameRu: 'Категория' },
  });
  const product = await db.product.create({
    data: {
      slug: `prod-${n}`,
      categoryId: category.id,
      nameUz: 'Mahsulot',
      nameRu: 'Товар',
      imageUrl: 'https://example.test/p.png',
      deliveryType: 'TG_USERNAME',
      inputSchema: [],
    },
  });
  const fxRate = await db.fxRate.create({
    data: { pair: 'TON_UZS', rate: '30000.5', source: 'test' },
  });
  const costSnapshot = await db.costSnapshot.create({
    data: {
      productId: product.id,
      adapter: 'FRAGMENT',
      currency: 'TON',
      basisQuantity: 50,
      costMinor: 1_000_000_000n,
      source: 'test',
    },
  });
  return db.quote.create({
    data: {
      userId,
      productId: product.id,
      quantity: 50,
      recipient: { username: 'someone' },
      costCurrency: 'TON',
      costMinor: 1_000_000_000n,
      fxRateId: fxRate.id,
      costSnapshotId: costSnapshot.id,
      priceTiyin: 5_000_000n,
      maxCostMinor: 1_100_000_000n,
      expiresAt: new Date(Date.now() + 600_000),
      ...overrides,
    },
  });
}

export async function createDiscountCode(userId: string): Promise<{ readonly id: string }> {
  const n = next();
  const tier = await db.discountTier.create({ data: { bps: 1000, priceCoins: 100n } });
  return db.discountCode.create({
    data: { userId, tierId: tier.id, bps: tier.bps, code: `DISC${n}-${Date.now()}` },
  });
}

export async function createOrder(
  user: User,
  idempotencyKey = `key-${next()}`,
  overrides: Partial<Prisma.OrderUncheckedCreateInput> = {},
  options: { readonly unguarded?: boolean } = {},
): Promise<Order> {
  // An order is created for its quote's recipient and providerRef (audit Y6): the quote gets the
  // providerRef the test asks the order for. An order with a discount needs a quote that carries a
  // discount code (audit Z4: no discount without a code), so the quote gets one.
  const hasDiscount = typeof overrides.discountTiyin === 'bigint' && overrides.discountTiyin !== 0n;
  const quote = await createQuote(user.id, {
    ...(overrides.providerRef === undefined ? {} : { providerRef: overrides.providerRef }),
    ...(hasDiscount ? { discountCodeId: (await createDiscountCode(user.id)).id } : {}),
  });
  const data: Prisma.OrderUncheckedCreateInput = {
    userId: user.id,
    quoteId: quote.id,
    productId: quote.productId,
    quantity: quote.quantity,
    recipient: { username: 'someone' },
    priceTiyin: quote.priceTiyin,
    costCurrency: quote.costCurrency,
    fxRateId: quote.fxRateId,
    costMinor: quote.costMinor,
    maxCostMinor: quote.maxCostMinor,
    status: 'PAID',
    idempotencyKey,
    requestHash: 'hash-a',
    ...overrides,
  };
  if (options.unguarded !== true) return db.order.create({ data });
  // For the CHECK tests of an order whose numbers differ from its quote's (audit Z4 refuses that
  // first): the triggers are switched off for this one INSERT (session_replication_role = replica,
  // local to the transaction). The CHECK constraints stay on; foreign keys are triggers too and are
  // off as well, so never use this for a foreign-key test.
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    return tx.order.create({ data });
  });
}

export async function createIntent(
  userId: string,
  idempotencyKey = `ik-${next()}`,
): Promise<PaymentIntent> {
  return db.paymentIntent.create({
    data: {
      userId,
      provider: 'CLICK',
      amountTiyin: 1_000_000n,
      purpose: 'TOPUP',
      idempotencyKey,
      requestHash: 'hash-a',
      expiresAt: new Date(Date.now() + 600_000),
    },
  });
}

type LoginRequestInput = Parameters<typeof db.loginRequest.create>[0]['data'];

/** A valid PENDING USER login request; override any column to build a case under test. */
export function loginRequestData(overrides: Partial<LoginRequestInput> = {}): LoginRequestInput {
  return {
    nonce: `nonce-${next()}-${Date.now()}`,
    kind: 'USER',
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 600_000),
    ...overrides,
  };
}
