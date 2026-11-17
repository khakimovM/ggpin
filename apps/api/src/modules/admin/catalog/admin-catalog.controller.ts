import { Get, Param, Query } from '@nestjs/common';
import type {
  AdminCategoryListResponse,
  AdminPricePreviewResponse,
  AdminProductDetailResponse,
  AdminProductListResponse,
} from '@repo/shared';
import { AdminAction } from '../common/admin-action.decorator';
import { AdminController } from '../common/admin-controller.decorator';
import { AdminPricePreviewQueryDto } from '../read/admin-read.dto';
import { adminResourceId } from '../read/admin-read-view';
import { AdminCatalogReadService } from './admin-catalog-read.service';

// `GET /api/v1/admin/{categories,products}*` (docs/04 «Katalog»): OWNER and OPERATOR
// (`catalog.read`, D-65 D4). Two path roots, so the class sits on the admin segment itself.
// The writes are S8.
@AdminController('')
export class AdminCatalogController {
  constructor(private readonly catalog: AdminCatalogReadService) {}

  @AdminAction('catalog.read')
  @Get('categories')
  categories(): Promise<AdminCategoryListResponse> {
    return this.catalog.categories();
  }

  @AdminAction('catalog.read')
  @Get('products')
  products(): Promise<AdminProductListResponse> {
    return this.catalog.products();
  }

  @AdminAction('catalog.read')
  @Get('products/:id')
  product(@Param('id') id: string): Promise<AdminProductDetailResponse> {
    return this.catalog.product(adminResourceId(id));
  }

  @AdminAction('catalog.read')
  @Get('products/:id/price-preview')
  pricePreview(
    @Param('id') id: string,
    @Query() query: AdminPricePreviewQueryDto,
  ): Promise<AdminPricePreviewResponse> {
    return this.catalog.pricePreview(adminResourceId(id), query);
  }
}
