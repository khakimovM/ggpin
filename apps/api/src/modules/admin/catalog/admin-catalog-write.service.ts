import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@repo/db';
import {
  isFullProductSet,
  type AdminCategoryUpdateBody,
  type AdminProductUpdateBody,
  type AdminRouteUpdateBody,
  type AdminSkuCreateBody,
  type AdminSkuUpdateBody,
} from '@repo/shared';
import { checkedReason } from '../../../common/admin/admin-input';
import { checkedAuditActor, type AdminActor } from '../../../common/admin/audit-actor';
import { confirmActorInTx, type ActorAfter } from '../../../common/admin/audit-actor.check';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { AppError } from '../../../common/exceptions/app-error';
import type { Db } from '../../../infra/prisma/db';
import {
  auditJson,
  catalogDiff,
  type CatalogDiff,
  type CatalogRecord,
} from './admin-catalog-write.diff';
import { ReviewEffects } from '../../payments/review-effects';
import {
  AdminCatalogWriteRepository,
  type CatalogAudit,
  type CatalogWriteStore,
  type LockedProduct,
} from './admin-catalog-write.repository';
import {
  catalogRuleError,
  checkPackageRules,
  checkPricingFields,
} from './admin-catalog-write.rules';
import {
  categoryFields,
  productFields,
  routeFields,
  skuFields,
  type CatalogResults,
  CatalogResultBuilder,
} from './admin-catalog-write.results';

type Target = Pick<CatalogAudit, 'action' | 'targetType' | 'targetId'>;

/**
 * Audited fields whose change the owners hear about (owner decision 2026-11-22): the price
 * (`markupBps`, `minMarginTiyin`) and what the store sells (`isActive` of a product or a
 * package, `isEnabled` of a route). Text, order and image edits raise nothing.
 */
const ALERT_FIELDS = ['markupBps', 'minMarginTiyin', 'isActive', 'isEnabled'] as const;
const raisesAlert = (diff: AuditDiff): boolean =>
  ALERT_FIELDS.some((field) => field in diff.before || field in diff.after);

/** The owners' alert after a commit (`ReviewEffects.adminAction` never throws). */
export type CatalogAlerts = Pick<ReviewEffects, 'adminAction'>;

/**
 * The six catalog writes of the admin panel (docs/04 «Katalog», D-63 (8), plan S8a), OWNER only.
 * Each is ONE transaction: the acting admin re-read FOR SHARE (`confirmActorInTx`, S2-6), the
 * row lock (Category, or the Product of the product / package / route, or every Product for a
 * reorder), the domain rules on the locked state, the diff, the write and an AuditLog row with
 * ONLY the changed fields, whose id is the request's Idempotency-Key row. A write that changes
 * nothing writes nothing: `auditId: null`, `applied: false`. The answer is read inside the
 * transaction, so nothing after the commit can turn it into an error.
 *
 * Prices: nothing here prices anything. A quote keeps the price it locked (Quote.priceTiyin);
 * new quotes and the preview read the saved package through money-pricing.ts. A changed
 * `quantity` no longer matches the package's cost snapshot, so the package is PRICE_UNAVAILABLE
 * until the worker syncs its cost (fail closed, money-pricing `costForQuantity`).
 *
 * A change of price or availability (`ALERT_FIELDS`) queues the owners' `adminAction` alert
 * AFTER the commit, as the S6 admin writes do (a rolled-back write tells nobody anything).
 */
@Injectable()
export class AdminCatalogWriteService {
  private readonly results: CatalogResultBuilder;

  constructor(
    @Inject(AdminCatalogWriteRepository) private readonly repo: CatalogWriteStore,
    @Inject(ReviewEffects) private readonly alerts: CatalogAlerts,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.results = new CatalogResultBuilder(repo);
  }

  updateCategory(actor: AdminActor, id: string, body: AdminCategoryUpdateBody) {
    return this.write(
      actor,
      body.reason,
      async (tx, audit): Promise<CatalogResults['category']> => {
        if (!(await this.repo.lockCategory(tx, id))) throw new AppError('NOT_FOUND');
        const current = await this.results.categorySource(tx, id);
        const diff = catalogDiff(categoryFields(current), {
          nameUz: body.nameUz,
          nameRu: body.nameRu,
          sort: body.sort,
        });
        if (diff.changed) {
          await this.repo.updateCategory(tx, id, diff.data);
          await audit(diff, { action: 'CATEGORY_UPDATE', targetType: 'Category', targetId: id });
        }
        return { category: await this.results.category(tx, id), ...this.result(actor, diff) };
      },
    );
  }

  updateProduct(actor: AdminActor, id: string, body: AdminProductUpdateBody) {
    return this.write(actor, body.reason, async (tx, audit): Promise<CatalogResults['product']> => {
      await this.lockProduct(tx, id);
      const { reason: _reason, ...asked } = body;
      const diff = catalogDiff(productFields(await this.results.productSource(tx, id)), asked);
      if (diff.changed) {
        await this.repo.updateProduct(tx, id, diff.data);
        await audit(diff, { action: 'PRODUCT_UPDATE', targetType: 'Product', targetId: id });
      }
      return { product: await this.results.product(tx, id), ...this.result(actor, diff) };
    });
  }

  /** Every product once, sort = index (`PRODUCT_SET_MISMATCH` otherwise). */
  reorder(actor: AdminActor, productIds: readonly string[]) {
    return this.write(actor, undefined, async (tx, audit): Promise<CatalogResults['reorder']> => {
      const all = await this.repo.lockAllProducts(tx);
      if (
        !isFullProductSet(
          all.map((row) => row.id),
          productIds,
        )
      ) {
        throw catalogRuleError('productIds', 'PRODUCT_SET_MISMATCH');
      }
      const was = new Map(all.map((row) => [row.id, row.sort]));
      const moved = productIds
        .map((id, sort) => ({ id, from: was.get(id) ?? -1, to: sort }))
        .filter((row) => row.from !== row.to);
      for (const row of moved) await this.repo.setSort(tx, row.id, row.to);
      if (moved.length > 0) {
        await audit(
          {
            before: { sorts: moved.map((row) => ({ id: row.id, sort: row.from })) },
            after: { sorts: moved.map((row) => ({ id: row.id, sort: row.to })) },
          },
          { action: 'PRODUCT_REORDER', targetType: 'Catalog', targetId: 'products' },
        );
      }
      const products = productIds.map((id, sort) => ({ id, sort }));
      return { products, ...this.result(actor, { changed: moved.length > 0 }) };
    });
  }

  /** A new package; the audit row targets the product (the panel knows only the product id). */
  async createSku(actor: AdminActor, productId: string, body: AdminSkuCreateBody) {
    const minMarginTiyin = BigInt(body.minMarginTiyin);
    checkPricingFields({ markupBps: body.markupBps, minMarginTiyin });
    return this.write(actor, body.reason, async (tx, audit): Promise<CatalogResults['sku']> => {
      const product = await this.lockProduct(tx, productId);
      const next = { skuId: null, quantity: body.quantity, isActive: body.isActive };
      await checkPackageRules(tx, this.repo, product, next, { quantity: true, isActive: true });
      const { reason: _reason, ...fields } = body;
      const sku = await this.repo.createSku(tx, productId, {
        ...fields,
        tab: fields.tab ?? null,
        supplierSku: fields.supplierSku ?? null,
        minMarginTiyin,
      });
      const after = { skuId: sku.id, ...skuFields(sku) };
      await audit(
        { before: {}, after: auditJson(after) },
        { action: 'SKU_CREATE', targetType: 'Product', targetId: productId },
      );
      return { sku: this.results.sku(sku), ...this.result(actor, { changed: true }) };
    });
  }

  async updateSku(actor: AdminActor, skuId: string, body: AdminSkuUpdateBody) {
    const minMarginTiyin =
      body.minMarginTiyin === undefined ? undefined : BigInt(body.minMarginTiyin);
    checkPricingFields({ markupBps: body.markupBps, minMarginTiyin });
    return this.write(actor, body.reason, async (tx, audit): Promise<CatalogResults['sku']> => {
      const productId = await this.repo.skuProductId(tx, skuId);
      if (productId === null) throw new AppError('NOT_FOUND');
      const product = await this.lockProduct(tx, productId);
      const current = await this.repo.sku(tx, productId, skuId);
      if (current === null) throw new AppError('NOT_FOUND');
      const { reason: _reason, ...asked } = body;
      const diff = catalogDiff(skuFields(current), { ...asked, minMarginTiyin });
      if (diff.changed) {
        const next = {
          skuId,
          quantity: diff.data.quantity ?? current.quantity,
          isActive: diff.data.isActive ?? current.isActive,
        };
        const touched = { quantity: 'quantity' in diff.data, isActive: 'isActive' in diff.data };
        await checkPackageRules(tx, this.repo, product, next, touched);
        await this.repo.updateSku(tx, skuId, diff.data);
        await audit(diff, { action: 'SKU_UPDATE', targetType: 'Sku', targetId: skuId });
      }
      const sku = await this.repo.sku(tx, productId, skuId);
      if (sku === null) throw new AppError('INTERNAL_ERROR');
      return { sku: this.results.sku(sku), ...this.result(actor, diff) };
    });
  }

  updateRoute(actor: AdminActor, routeId: string, body: AdminRouteUpdateBody) {
    return this.write(actor, body.reason, async (tx, audit): Promise<CatalogResults['route']> => {
      const productId = await this.repo.routeProductId(tx, routeId);
      if (productId === null) throw new AppError('NOT_FOUND');
      await this.lockProduct(tx, productId);
      const current = await this.repo.route(tx, productId, routeId);
      if (current === null) throw new AppError('NOT_FOUND');
      const diff = catalogDiff(routeFields(current), {
        priority: body.priority,
        isEnabled: body.isEnabled,
      });
      if (diff.changed) {
        await this.repo.updateRoute(tx, routeId, diff.data);
        await audit(diff, {
          action: 'ROUTE_UPDATE',
          targetType: 'ProductRoute',
          targetId: routeId,
        });
      }
      const route = await this.repo.route(tx, productId, routeId);
      if (route === null) throw new AppError('INTERNAL_ERROR');
      return { route: this.results.route(route), ...this.result(actor, diff) };
    });
  }

  private async lockProduct(tx: Db, id: string): Promise<LockedProduct> {
    const product = await this.repo.lockProduct(tx, id);
    if (product === null) throw new AppError('NOT_FOUND');
    return product;
  }

  /**
   * One transaction: the actor re-read first, then the work; `audit` writes the one row. After
   * the commit, an audited price or availability change raises the owners' alert.
   */
  private async write<R>(
    actor: AdminActor,
    reason: string | undefined,
    work: (tx: Db, audit: AuditWriter) => Promise<R>,
  ): Promise<R> {
    const checked = checkedAuditActor(actor);
    const why = reason === undefined ? undefined : checkedReason(reason);
    const now = this.clock.now();
    const done = await this.repo.transaction(async (tx) => {
      // Per attempt: only an audit row written in the committed transaction raises the alert.
      const raised = { alert: false };
      const who: ActorAfter = await confirmActorInTx(tx, checked, now);
      const audit: AuditWriter = (diff, target) => {
        raised.alert = raisesAlert(diff);
        return this.repo.createAudit(tx, {
          id: actor.request.auditId,
          actorId: actor.adminId,
          ip: actor.ip,
          ...target,
          before: diff.before,
          after: { ...diff.after, ...who },
          reason: why,
        });
      };
      const result = await work(tx, audit);
      return { result, alert: raised.alert };
    });
    if (done.alert) await this.alerts.adminAction(actor.request.auditId);
    return done.result;
  }

  private result(
    actor: AdminActor,
    diff: Pick<CatalogDiff<CatalogRecord>, 'changed'>,
  ): { auditId: string | null; applied: boolean } {
    return diff.changed
      ? { auditId: actor.request.auditId, applied: true }
      : { auditId: null, applied: false };
  }
}

/** Changed fields only (old in `before`, new in `after`); the actor facts join `after`. */
interface AuditDiff {
  readonly before: Prisma.InputJsonObject;
  readonly after: Prisma.InputJsonObject;
}
type AuditWriter = (diff: AuditDiff, target: Target) => Promise<void>;
