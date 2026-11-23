import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/exceptions/app-error';
import { afterField, type AdminAuditRow } from '../write/admin-write.repository';
import { AdminCatalogWriteRepository } from './admin-catalog-write.repository';
import { CatalogResultBuilder, type CatalogResults } from './admin-catalog-write.results';

/**
 * The answer to a replayed catalog write (docs/04 «Admin» — `Idempotency-Key`): the row the first
 * call changed, read as it is NOW, with the first call's auditId and `applied: false`. Nothing is
 * written. Only an applied write has an audit row, so only those can be replayed; a no-op first
 * call left no row and its key simply runs again (and is a no-op again, or applies now).
 */
@Injectable()
export class AdminCatalogWriteReplays {
  private readonly results: CatalogResultBuilder;

  constructor(private readonly repo: AdminCatalogWriteRepository) {
    this.results = new CatalogResultBuilder(repo);
  }

  async category(row: AdminAuditRow): Promise<CatalogResults['category']> {
    const category = await this.results.category(this.repo.client(), row.targetId);
    return { category, auditId: row.id, applied: false };
  }

  async product(row: AdminAuditRow): Promise<CatalogResults['product']> {
    const product = await this.results.product(this.repo.client(), row.targetId);
    return { product, auditId: row.id, applied: false };
  }

  /** The same body was sent (the request hash matched): its ids, with their sort now. */
  async reorder(
    row: AdminAuditRow,
    productIds: readonly string[],
  ): Promise<CatalogResults['reorder']> {
    const now = new Map(
      (await this.repo.sorts(this.repo.client(), productIds)).map((p) => [p.id, p.sort]),
    );
    const products = productIds.map((id) => {
      const sort = now.get(id);
      if (sort === undefined) throw new AppError('NOT_FOUND');
      return { id, sort };
    });
    return { products, auditId: row.id, applied: false };
  }

  /** SKU_CREATE targets the product; the new package id is in `after.skuId`. */
  async skuCreate(row: AdminAuditRow): Promise<CatalogResults['sku']> {
    const skuId = afterField(row, 'skuId');
    if (typeof skuId !== 'string') throw new AppError('INTERNAL_ERROR');
    return this.skuAnswer(row, row.targetId, skuId);
  }

  async skuUpdate(row: AdminAuditRow): Promise<CatalogResults['sku']> {
    const productId = await this.repo.skuProductId(this.repo.client(), row.targetId);
    if (productId === null) throw new AppError('NOT_FOUND');
    return this.skuAnswer(row, productId, row.targetId);
  }

  async route(row: AdminAuditRow): Promise<CatalogResults['route']> {
    const db = this.repo.client();
    const productId = await this.repo.routeProductId(db, row.targetId);
    const route = productId === null ? null : await this.repo.route(db, productId, row.targetId);
    if (route === null) throw new AppError('NOT_FOUND');
    return { route: this.results.route(route), auditId: row.id, applied: false };
  }

  private async skuAnswer(
    row: AdminAuditRow,
    productId: string,
    skuId: string,
  ): Promise<CatalogResults['sku']> {
    const sku = await this.repo.sku(this.repo.client(), productId, skuId);
    if (sku === null) throw new AppError('NOT_FOUND');
    return { sku: this.results.sku(sku), auditId: row.id, applied: false };
  }
}
