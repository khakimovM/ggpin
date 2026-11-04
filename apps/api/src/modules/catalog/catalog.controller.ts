import { Controller, Get, Param, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { CatalogCategory, CatalogProductDetail, CatalogProductListItem } from '@repo/shared';
import { PublicCache } from '../../common/http/public-cache.decorator';
import type { WithMeta } from '../../common/http/with-meta';
import { CatalogService } from './catalog.service';
import {
  CatalogLocaleQueryDto,
  ProductListQueryDto,
  ProductSlugParamsDto,
} from './dto/catalog.dto';

const MINUTE_MS = 60_000;
// Cached for a minute (Q13). Many Mini App users share one carrier IP, so the per-IP budget is
// generous (Q14); a cache hit never reaches the API anyway.
const CATALOG_CACHE_SEC = 60;
const CATALOG_RATE = { default: { limit: 600, ttl: MINUTE_MS } };

// Identical for every caller, hence @PublicCache on each handler (Fastify route config is read
// from the method, not the class): no session, no per-user data on these routes.
@Controller('catalog')
@Throttle(CATALOG_RATE)
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @PublicCache(CATALOG_CACHE_SEC)
  @Get('categories')
  categories(@Query() query: CatalogLocaleQueryDto): Promise<CatalogCategory[]> {
    return this.catalog.categories(query.locale);
  }

  @PublicCache(CATALOG_CACHE_SEC)
  @Get('products')
  products(
    @Query() query: ProductListQueryDto,
  ): Promise<WithMeta<readonly CatalogProductListItem[]>> {
    return this.catalog.products(query);
  }

  @PublicCache(CATALOG_CACHE_SEC)
  @Get('products/:slug')
  product(
    @Param() params: ProductSlugParamsDto,
    @Query() query: CatalogLocaleQueryDto,
  ): Promise<CatalogProductDetail> {
    return this.catalog.product(params.slug, query.locale);
  }
}
