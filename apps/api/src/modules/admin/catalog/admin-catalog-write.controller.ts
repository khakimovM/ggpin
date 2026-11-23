import { Body, HttpCode, Ip, Param, Patch, Post } from '@nestjs/common';
import type { AdminPermission } from '@repo/shared';
import type { AdminActor } from '../../../common/admin/audit-actor';
import { IdempotencyKey } from '../../payments/idempotency-key.decorator';
import { AdminAction } from '../common/admin-action.decorator';
import { AdminController } from '../common/admin-controller.decorator';
import type { AdminPrincipal } from '../common/admin-request';
import { CurrentAdmin } from '../common/current-admin.decorator';
import { adminResourceId } from '../read/admin-read-view';
import type { AdminAuditRow } from '../write/admin-write.repository';
import { AdminWriteRunner } from '../write/admin-write.runner';
import {
  AdminCategoryUpdateBodyDto,
  AdminProductReorderBodyDto,
  AdminProductUpdateBodyDto,
  AdminRouteUpdateBodyDto,
  AdminSkuCreateBodyDto,
  AdminSkuUpdateBodyDto,
} from './admin-catalog-write.dto';
import { AdminCatalogWriteReplays } from './admin-catalog-write.replays';
import type { CatalogResults } from './admin-catalog-write.results';
import { AdminCatalogWriteService } from './admin-catalog-write.service';

interface Call {
  readonly principal: AdminPrincipal;
  readonly ip: string;
  readonly key: string;
  readonly targetId: string;
  readonly body: object;
  readonly permission: AdminPermission;
}

/** The reorder has no single target: its audit row is `Catalog/products`. */
const REORDER_TARGET = 'products';

// The catalog writes (docs/04 «Katalog», D-63 (8)): OWNER only (matrix `catalog.*`), each on
// AdminWriteRunner (Idempotency-Key replay before any check) and one service transaction. No
// step-up code (docs/04 matrix: «Katalog yozuvi — kod yo‘q»). Two path roots and `skus` /
// `routes`, so the class sits on the admin segment itself, like the catalog reads.
@AdminController('')
export class AdminCatalogWriteController {
  constructor(
    private readonly runner: AdminWriteRunner,
    private readonly replays: AdminCatalogWriteReplays,
    private readonly catalog: AdminCatalogWriteService,
  ) {}

  @AdminAction('catalog.categoryUpdate')
  @Patch('categories/:id')
  updateCategory(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @IdempotencyKey() key: string,
    @Param('id') id: string,
    @Body() body: AdminCategoryUpdateBodyDto,
  ): Promise<CatalogResults['category']> {
    const targetId = adminResourceId(id);
    return this.run(
      { principal, ip, key, targetId, body, permission: 'catalog.categoryUpdate' },
      (row) => this.replays.category(row),
      (actor) => this.catalog.updateCategory(actor, targetId, body),
    );
  }

  @AdminAction('catalog.productUpdate')
  @Patch('products/:id')
  updateProduct(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @IdempotencyKey() key: string,
    @Param('id') id: string,
    @Body() body: AdminProductUpdateBodyDto,
  ): Promise<CatalogResults['product']> {
    const targetId = adminResourceId(id);
    return this.run(
      { principal, ip, key, targetId, body, permission: 'catalog.productUpdate' },
      (row) => this.replays.product(row),
      (actor) => this.catalog.updateProduct(actor, targetId, body),
    );
  }

  @AdminAction('catalog.productReorder')
  @Post('products/reorder')
  @HttpCode(200)
  reorder(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @IdempotencyKey() key: string,
    @Body() body: AdminProductReorderBodyDto,
  ): Promise<CatalogResults['reorder']> {
    return this.run(
      {
        ...{ principal, ip, key, body },
        targetId: REORDER_TARGET,
        permission: 'catalog.productReorder',
      },
      (row) => this.replays.reorder(row, body.productIds),
      (actor) => this.catalog.reorder(actor, body.productIds),
    );
  }

  @AdminAction('catalog.skuCreate')
  @Post('products/:id/skus')
  @HttpCode(200)
  createSku(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @IdempotencyKey() key: string,
    @Param('id') id: string,
    @Body() body: AdminSkuCreateBodyDto,
  ): Promise<CatalogResults['sku']> {
    const targetId = adminResourceId(id);
    return this.run(
      { principal, ip, key, targetId, body, permission: 'catalog.skuCreate' },
      (row) => this.replays.skuCreate(row),
      (actor) => this.catalog.createSku(actor, targetId, body),
    );
  }

  @AdminAction('catalog.skuUpdate')
  @Patch('skus/:id')
  updateSku(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @IdempotencyKey() key: string,
    @Param('id') id: string,
    @Body() body: AdminSkuUpdateBodyDto,
  ): Promise<CatalogResults['sku']> {
    const targetId = adminResourceId(id);
    return this.run(
      { principal, ip, key, targetId, body, permission: 'catalog.skuUpdate' },
      (row) => this.replays.skuUpdate(row),
      (actor) => this.catalog.updateSku(actor, targetId, body),
    );
  }

  @AdminAction('catalog.routeUpdate')
  @Patch('routes/:id')
  updateRoute(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @IdempotencyKey() key: string,
    @Param('id') id: string,
    @Body() body: AdminRouteUpdateBodyDto,
  ): Promise<CatalogResults['route']> {
    const targetId = adminResourceId(id);
    return this.run(
      { principal, ip, key, targetId, body, permission: 'catalog.routeUpdate' },
      (row) => this.replays.route(row),
      (actor) => this.catalog.updateRoute(actor, targetId, body),
    );
  }

  private run<T>(
    call: Call,
    replay: (row: AdminAuditRow) => Promise<T>,
    work: (actor: AdminActor) => Promise<T>,
  ): Promise<T> {
    return this.runner.run({ ...call, replay }, work);
  }
}
