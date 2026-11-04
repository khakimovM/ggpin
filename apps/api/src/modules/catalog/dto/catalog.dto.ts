import {
  CatalogLocaleQuerySchema,
  ProductListQuerySchema,
  ProductSlugParamsSchema,
} from '@repo/shared';
import { createZodDto } from 'nestjs-zod';

export class CatalogLocaleQueryDto extends createZodDto(CatalogLocaleQuerySchema) {}
export class ProductListQueryDto extends createZodDto(ProductListQuerySchema) {}
export class ProductSlugParamsDto extends createZodDto(ProductSlugParamsSchema) {}
