import type { AdminActor } from '../../../../common/admin/audit-actor';
import type { Db } from '../../../../infra/prisma/db';
import type {
  AdminCategorySource,
  AdminProductDetailSource,
} from '../admin-catalog-read.repository';
import type { CatalogAlerts } from '../admin-catalog-write.service';
import type {
  AdminRouteSource,
  AdminSkuSource,
  CatalogAudit,
  CatalogWriteStore,
  LockedProduct,
} from '../admin-catalog-write.repository';

// An in-memory CatalogWriteStore (the repository slice the service uses) for the unit tests: one
// product with its packages and routes, one category, a log of every call (the lock comes first)
// and the owners' alerts raised after a commit.

export const IDS = {
  admin: 'cmadmin0000000000000000001',
  session: 'cmsession00000000000000001',
  audit: 'a0123456789abcdef0123456789abcd',
  category: 'cmcategory0000000000000001',
  product: 'cmproduct00000000000000001',
  other: 'cmproduct00000000000000002',
  sku: 'cmsku000000000000000000001',
  sku2: 'cmsku000000000000000000002',
  route: 'cmroute0000000000000000001',
} as const;

export function ownerActor(): AdminActor {
  return {
    kind: 'ADMIN',
    adminId: IDS.admin,
    sessionId: IDS.session,
    ip: '203.0.113.7',
    permission: 'catalog.skuUpdate',
    request: { auditId: IDS.audit, requestHash: 'h'.repeat(64) },
  };
}

export interface AdminRowState {
  role: 'OWNER' | 'OPERATOR' | 'SUPPORT';
  isActive: boolean;
}

/** A transaction client that answers only what `confirmActorInTx` reads. */
export function fakeTx(admin: AdminRowState): Db {
  const tx = {
    $queryRaw: () => Promise.resolve([{ id: IDS.admin, ...admin }]),
    adminSession: {
      findUnique: () =>
        Promise.resolve({
          adminId: IDS.admin,
          revokedAt: null,
          expiresAt: new Date('2999-01-01T00:00:00.000Z'),
        }),
    },
  };
  return tx as unknown as Db;
}

const sku = (id: string, quantity: number, isActive = true): AdminSkuSource => ({
  id,
  tab: null,
  labelUz: `${String(quantity)} ta`,
  labelRu: `${String(quantity)} шт`,
  quantity,
  supplierSku: null,
  markupBps: 1500,
  minMarginTiyin: 0n,
  isActive,
  sort: 0,
});

/** The product columns the fake keeps (its packages and routes are the lists below). */
type ProductRow = Omit<AdminProductDetailSource, 'skus' | 'routes'>;

/** The owners' alerts the service raised (after the commit), by audit id. */
export class FakeAlerts implements CatalogAlerts {
  readonly raised: string[] = [];

  /** `calls` is the repository's log: the alert joins it, to prove it follows the commit. */
  constructor(private readonly calls: string[]) {}

  adminAction(auditId: string): Promise<boolean> {
    this.raised.push(auditId);
    this.calls.push('alert');
    return Promise.resolve(true);
  }
}

export class FakeCatalogRepo implements CatalogWriteStore {
  readonly calls: string[] = [];
  readonly audits: CatalogAudit[] = [];
  admin: AdminRowState = { role: 'OWNER', isActive: true };
  locked: LockedProduct = {
    id: IDS.product,
    slug: 'test-stars',
    allowCustomQty: true,
    minQty: 10,
    maxQty: 10_000,
  };
  products = [
    { id: IDS.product, sort: 0 },
    { id: IDS.other, sort: 1 },
  ];
  categoryRow: AdminCategorySource = {
    id: IDS.category,
    slug: 'cat',
    nameUz: 'Telegram',
    nameRu: 'Телеграм',
    sort: 0,
    _count: { products: 2 },
  };
  productRow: ProductRow = {
    id: IDS.product,
    slug: 'test-stars',
    categoryId: IDS.category,
    nameUz: 'Yulduzlar',
    nameRu: 'Звёзды',
    imageUrl: '/assets/products/stars.png',
    deliveryType: 'TG_USERNAME',
    isActive: true,
    isFeatured: false,
    sort: 0,
    _count: { skus: 2, routes: 1 },
    descriptionUz: null,
    descriptionRu: null,
    helpUz: null,
    helpRu: null,
    regionBadge: null,
    isAuto: true,
    allowCustomQty: true,
    minQty: 10,
    maxQty: 10_000,
    updatedAt: new Date('2026-11-22T09:00:00.000Z'),
  };
  skus: AdminSkuSource[] = [sku(IDS.sku, 50), sku(IDS.sku2, 100)];
  routes: (AdminRouteSource & { productId: string })[] = [
    { id: IDS.route, productId: IDS.product, adapter: 'FRAGMENT', priority: 1, isEnabled: true },
  ];

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    this.calls.push('begin');
    const result = await fn(fakeTx(this.admin));
    this.calls.push('commit');
    return result;
  }

  lockCategory(_tx: Db, id: string) {
    this.calls.push('lockCategory');
    return Promise.resolve(id === this.categoryRow.id);
  }

  lockProduct(_tx: Db, id: string) {
    this.calls.push('lockProduct');
    return Promise.resolve(id === this.locked.id ? this.locked : null);
  }

  lockAllProducts() {
    this.calls.push('lockAllProducts');
    return Promise.resolve(this.products.map((row) => ({ ...row })));
  }

  skuProductId(_db: Db, skuId: string) {
    return Promise.resolve(this.skus.some((row) => row.id === skuId) ? this.locked.id : null);
  }

  routeProductId(_db: Db, routeId: string) {
    return Promise.resolve(this.routes.find((row) => row.id === routeId)?.productId ?? null);
  }

  category(_db: Db, id: string) {
    return Promise.resolve(id === this.categoryRow.id ? { ...this.categoryRow } : null);
  }

  product(_db: Db, id: string) {
    if (id !== this.productRow.id) return Promise.resolve(null);
    const skus = this.skus.map((row) => ({ ...row }));
    const routes = this.routes.map(({ productId: _p, ...rest }) => rest);
    return Promise.resolve({ ...this.productRow, skus, routes });
  }

  updateProduct(_tx: Db, _id: string, data: Partial<ProductRow>) {
    this.calls.push('write');
    this.productRow = { ...this.productRow, ...data };
    return Promise.resolve();
  }

  sku(_db: Db, productId: string, skuId: string) {
    this.calls.push('readSku');
    const row = this.skus.find((candidate) => candidate.id === skuId);
    return Promise.resolve(productId === this.locked.id && row ? { ...row } : null);
  }

  route(_db: Db, productId: string, routeId: string) {
    const row = this.routes.find((candidate) => candidate.id === routeId);
    if (row === undefined || row.productId !== productId) return Promise.resolve(null);
    const { productId: _p, ...rest } = row;
    return Promise.resolve(rest);
  }

  activeSkusWithQuantity(_tx: Db, _productId: string, quantity: number, except: string | null) {
    this.calls.push('countTwins');
    return Promise.resolve(
      this.skus.filter((row) => row.isActive && row.quantity === quantity && row.id !== except)
        .length,
    );
  }

  updateCategory(_tx: Db, _id: string, data: Partial<AdminCategorySource>) {
    this.calls.push('write');
    this.categoryRow = { ...this.categoryRow, ...data };
    return Promise.resolve();
  }

  updateSku(_tx: Db, id: string, data: Partial<AdminSkuSource>) {
    this.calls.push('write');
    this.skus = this.skus.map((row) => (row.id === id ? { ...row, ...data } : row));
    return Promise.resolve();
  }

  createSku(_tx: Db, _productId: string, data: Omit<AdminSkuSource, 'id'>) {
    this.calls.push('write');
    const row = { ...data, id: `cmskunew${String(this.skus.length).padStart(18, '0')}` };
    this.skus.push(row);
    return Promise.resolve({ ...row });
  }

  updateRoute(_tx: Db, id: string, data: Partial<AdminRouteSource>) {
    this.calls.push('write');
    this.routes = this.routes.map((row) => (row.id === id ? { ...row, ...data } : row));
    return Promise.resolve();
  }

  setSort(_tx: Db, id: string, sort: number) {
    this.calls.push('write');
    this.products = this.products.map((row) => (row.id === id ? { ...row, sort } : row));
    return Promise.resolve();
  }

  createAudit(_tx: Db, data: CatalogAudit) {
    this.calls.push('audit');
    this.audits.push(data);
    return Promise.resolve();
  }
}
