import { Body, HttpCode, Post } from '@nestjs/common';
import {
  AdminConfirmationBodySchema,
  type AdminConfirmationBody,
  type AdminConfirmationResponse,
} from '@repo/shared';
import { ZodValidationPipe } from 'nestjs-zod';
import { AdminAction } from '../common/admin-action.decorator';
import { AdminController } from '../common/admin-controller.decorator';
import type { AdminPrincipal } from '../common/admin-request';
import { CurrentAdmin } from '../common/current-admin.decorator';
import { AdminConfirmService } from './admin-confirm.service';

// `POST /api/v1/admin/confirmations` (docs/04): no Idempotency-Key (issuing writes nothing).
@AdminController('confirmations')
export class AdminConfirmController {
  constructor(private readonly confirm: AdminConfirmService) {}

  @AdminAction('confirmations.create')
  @Post()
  @HttpCode(201)
  create(
    @CurrentAdmin() principal: AdminPrincipal,
    // A discriminated union (one shape per action) is no DTO class: its own pipe, same errors.
    @Body(new ZodValidationPipe(AdminConfirmationBodySchema)) body: AdminConfirmationBody,
  ): Promise<AdminConfirmationResponse> {
    return this.confirm.create(principal, body);
  }
}
