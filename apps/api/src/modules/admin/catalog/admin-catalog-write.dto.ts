import {
  AdminCategoryUpdateBodySchema,
  AdminProductReorderBodySchema,
  AdminProductUpdateBodySchema,
  AdminRouteUpdateBodySchema,
  AdminSkuCreateBodySchema,
  AdminSkuUpdateBodySchema,
} from '@repo/shared';
import { createZodDto } from 'nestjs-zod';

// Bodies of the catalog write routes (S8a): the shared strict Zod schemas, validated by the global
// ZodValidationPipe after the admin guards (docs/04: shape errors only for a live session).
export class AdminCategoryUpdateBodyDto extends createZodDto(AdminCategoryUpdateBodySchema) {}
export class AdminProductUpdateBodyDto extends createZodDto(AdminProductUpdateBodySchema) {}
export class AdminProductReorderBodyDto extends createZodDto(AdminProductReorderBodySchema) {}
export class AdminSkuCreateBodyDto extends createZodDto(AdminSkuCreateBodySchema) {}
export class AdminSkuUpdateBodyDto extends createZodDto(AdminSkuUpdateBodySchema) {}
export class AdminRouteUpdateBodyDto extends createZodDto(AdminRouteUpdateBodySchema) {}
