import {
  CreateOrderBodySchema,
  OrderDetailQuerySchema,
  OrderListQuerySchema,
  OrderParamsSchema,
} from '@repo/shared';
import { createZodDto } from 'nestjs-zod';

// The wire schemas of docs/04 "Buyurtmalar" live in packages/shared (one source of truth with the
// frontend); these classes only hand them to the global ZodValidationPipe.
export class CreateOrderBodyDto extends createZodDto(CreateOrderBodySchema) {}
export class OrderListQueryDto extends createZodDto(OrderListQuerySchema) {}
export class OrderDetailQueryDto extends createZodDto(OrderDetailQuerySchema) {}
export class OrderParamsDto extends createZodDto(OrderParamsSchema) {}
