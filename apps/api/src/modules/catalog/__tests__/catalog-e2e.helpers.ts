import { randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../../app.module';
import { configureApp } from '../../../app.setup';
import { CLOCK } from '../../../common/clock/clock';
import { createHttpAdapter } from '../../../common/http/create-http-adapter';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import { PrismaService } from '../../../infra/prisma/prisma.service';

const API = '/api/v1/catalog';
const MINUTE_MS = 60_000;
const STALE_AFTER_MS = 30 * MINUTE_MS;

export interface Envelope {
  readonly success: boolean;
  readonly data?: unknown;
  readonly meta?: unknown;
  readonly error?: { readonly code: string };
}
export interface CategoryOut {
  readonly slug: string;
  readonly name: string;
  readonly productCount: number;
}
export interface ProductOut {
  readonly slug: string;
  readonly name: string;
  readonly fromPriceTiyin: string | null;
  readonly inStock: boolean;
}
export interface DetailOut {
  readonly name: string;
  readonly description: string | null;
  readonly help: string | null;
  readonly stock: number | null;
  readonly unitPriceTiyin: string | null;
  readonly skus: readonly { readonly label: string; readonly fromPriceTiyin: string | null }[];
}

export interface CatalogE2e {
  readonly get: (path: string) => Promise<ApiResponse>;
  readonly slug: (name: string) => string;
  /** Any method and headers, for cache-policy checks (HEAD, Origin). Body is not parsed. */
  readonly send: (
    method: 'GET' | 'HEAD',
    path: string,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; headers: Record<string, unknown> }>;
  readonly webOrigin: string;
  readonly sfx: string;
  /** Moves the clock the app sees; reset to the creation time before every test. */
  readonly setNow: (date: Date) => void;
  /** When the fixtures were created (the app clock starts here). */
  readonly base: Date;
  /** Age at which a price is still fresh; one millisecond more and it is stale. */
  readonly stalePointMs: number;
}

export interface ApiResponse {
  readonly status: number;
  readonly headers: Record<string, unknown>;
  readonly body: Envelope;
}

// Boots the real app on the *_test database with a movable clock. Fixtures are created here and
// removed in afterAll (never the seed): slugs carry a random suffix and every assertion filters
// by those slugs, so rows from other suites on the shared database cannot interfere.
export function useCatalogE2e(): CatalogE2e {
  const sfx = randomBytes(4).toString('hex');
  const slug = (name: string): string => `e2e-${name}-${sfx}`;
  const env = buildE2eEnv();
  const base = new Date();
  let now = base;
  let app: NestFastifyApplication;
  let db: PrismaService['client'];
  const ids = {
    categories: [] as string[],
    products: [] as string[],
    skus: [] as string[],
    fxRates: [] as string[],
    snapshots: [] as string[],
  };

  const get = async (
    path: string,
  ): Promise<{ status: number; headers: Record<string, unknown>; body: Envelope }> => {
    const res = await app.inject({ method: 'GET', url: `${API}${path}` });
    return { status: res.statusCode, headers: res.headers, body: res.json<Envelope>() };
  };

  const send: CatalogE2e['send'] = async (method, path, headers = {}) => {
    const res = await app.inject({ method, url: `${API}${path}`, headers });
    return { status: res.statusCode, headers: res.headers };
  };

  const category = async (name: string, nameUz: string, nameRu: string, sort: number) => {
    const row = await db.category.create({ data: { slug: slug(name), nameUz, nameRu, sort } });
    ids.categories.push(row.id);
    return row;
  };

  interface ProductSpec {
    readonly name: string;
    readonly categoryId: string;
    readonly nameUz: string;
    readonly nameRu: string;
    readonly isActive?: boolean;
    readonly sort?: number;
    readonly custom?: boolean;
    readonly delivery?: 'TG_USERNAME' | 'VOUCHER';
  }
  const product = async (spec: ProductSpec) => {
    const row = await db.product.create({
      data: {
        slug: slug(spec.name),
        categoryId: spec.categoryId,
        nameUz: spec.nameUz,
        nameRu: spec.nameRu,
        descriptionUz: `${spec.nameUz}: tavsif`,
        descriptionRu: `${spec.nameRu}: описание`,
        helpUz: 'Yordam matni',
        helpRu: 'Текст помощи',
        imageUrl: `/images/${spec.name}.png`,
        regionBadge: 'GLOBAL',
        deliveryType: spec.delivery ?? 'TG_USERNAME',
        inputSchema: [{ key: 'username', type: 'tgUsername', label: 'fields.tgUsername' }],
        isActive: spec.isActive ?? true,
        sort: spec.sort ?? 0,
        allowCustomQty: spec.custom ?? false,
        minQty: spec.custom ? 50 : null,
        maxQty: spec.custom ? 100_000 : null,
      },
    });
    ids.products.push(row.id);
    return row;
  };

  const sku = async (
    productId: string,
    quantity: number,
    labelUz: string,
    labelRu: string,
    isActive = true,
  ) => {
    const row = await db.sku.create({
      data: {
        productId,
        quantity,
        labelUz,
        labelRu,
        markupBps: 1000,
        minMarginTiyin: 0n,
        isActive,
        sort: quantity,
      },
    });
    ids.skus.push(row.id);
    return row;
  };

  const cost = async (
    productId: string,
    skuId: string | null,
    basisQuantity: number,
    costMinor: bigint,
  ) => {
    const row = await db.costSnapshot.create({
      data: {
        productId,
        skuId,
        adapter: 'FRAGMENT',
        currency: 'TON',
        basisQuantity,
        costMinor,
        source: 'fixture',
        createdAt: base,
      },
    });
    ids.snapshots.push(row.id);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(env)] })
      .overrideProvider(CLOCK)
      .useValue({ now: () => now })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter(env), {
      logger: false,
    });
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(PrismaService).client;

    const fx = await db.fxRate.create({
      data: { pair: 'TON_UZS', rate: '40000', source: 'fixture', createdAt: base },
    });
    ids.fxRates.push(fx.id);

    const tg = await category('tg', 'Telegram xizmatlari', 'Сервисы Telegram', 1);
    const games = await category('games', 'O‘yinlar', 'Игры', 2);
    const onlyInactive = await category('inactive', 'Yashirin', 'Скрытая', 3);
    await category('empty', 'Bo‘sh', 'Пустая', 4);

    // Telegram Stars: one product-level cost per star, a custom quantity range and 2 active packs.
    const stars = await product({
      name: 'stars',
      categoryId: tg.id,
      nameUz: 'Telegram Stars',
      nameRu: 'Telegram Stars',
      sort: 1,
      custom: true,
    });
    await sku(stars.id, 50, '50 ⭐', '50 ⭐ звёзд');
    await sku(stars.id, 100, '100 ⭐', '100 ⭐ звёзд');
    await sku(stars.id, 500, '500 ⭐', '500 ⭐', false);
    await cost(stars.id, null, 1, 2_500_000n);

    // Premium: a pack-level cost for the 3-month pack only; the 6-month pack has no cost yet.
    const premium = await product({
      name: 'premium',
      categoryId: tg.id,
      nameUz: 'Telegram Premium',
      nameRu: 'Telegram Premium',
      sort: 2,
    });
    const threeMonths = await sku(premium.id, 3, '3 oylik', '3 месяца');
    await sku(premium.id, 6, '6 oylik', '6 месяцев');
    await cost(premium.id, threeMonths.id, 3, 3_000_000_000n);

    await product({
      name: 'hidden',
      categoryId: tg.id,
      nameUz: 'Yashirin mahsulot',
      nameRu: 'Скрытый товар',
      isActive: false,
      sort: 3,
    });
    await product({
      name: 'only-inactive',
      categoryId: onlyInactive.id,
      nameUz: 'Faol emas',
      nameRu: 'Неактивный',
      isActive: false,
    });

    // Search fixtures: a literal "%" and a literal "_" in the names.
    await product({
      name: 'pct',
      categoryId: games.id,
      nameUz: 'Olmos 100% paket',
      nameRu: 'Алмазы пакет',
      sort: 1,
    });
    await product({
      name: 'plain',
      categoryId: games.id,
      nameUz: 'Olmos oddiy',
      nameRu: 'Алмазы обычные',
      sort: 2,
    });
    await product({
      name: 'under',
      categoryId: games.id,
      nameUz: 'Snake_case o‘yin',
      nameRu: 'Змея',
      sort: 3,
    });

    const voucher = await product({
      name: 'voucher',
      categoryId: games.id,
      nameUz: 'Kod',
      nameRu: 'Код',
      sort: 4,
      delivery: 'VOUCHER',
    });
    const code = await sku(voucher.id, 1, '1 dona', '1 штука');
    await db.voucher.createMany({
      data: [1, 2, 3].map((n) => ({
        skuId: code.id,
        codeEnc: `enc-${sfx}-${String(n)}`,
        codeHash: `hash-${sfx}-${String(n)}`,
        costMicroUsdt: 1_000_000n,
        status: n === 3 ? ('SOLD' as const) : ('AVAILABLE' as const),
      })),
    });
  });

  afterAll(async () => {
    await db.voucher.deleteMany({ where: { skuId: { in: ids.skus } } });
    await db.costSnapshot.deleteMany({ where: { id: { in: ids.snapshots } } });
    await db.fxRate.deleteMany({ where: { id: { in: ids.fxRates } } });
    await db.sku.deleteMany({ where: { id: { in: ids.skus } } });
    await db.product.deleteMany({ where: { id: { in: ids.products } } });
    await db.category.deleteMany({ where: { id: { in: ids.categories } } });
    await app.close();
  });

  beforeEach(() => {
    now = base;
  });

  return {
    get,
    send,
    webOrigin: env.WEB_URL,
    slug,
    sfx,
    setNow: (date) => {
      now = date;
    },
    base,
    stalePointMs: STALE_AFTER_MS,
  };
}
