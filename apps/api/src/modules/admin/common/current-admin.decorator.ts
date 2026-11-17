import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { AppError } from '../../../common/exceptions/app-error';
import type { AdminPrincipal, AdminRequest } from './admin-request';

// `@CurrentAdmin()` -> the AdminPrincipal AdminGuard attached. The only source of an admin id
// for services: never a body, query or path parameter. Without one it fails closed with the
// admin surface's single refusal (404, D-26).
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AdminPrincipal => {
    const principal = context.switchToHttp().getRequest<AdminRequest>().adminPrincipal;
    if (principal === undefined) throw new AppError('NOT_FOUND');
    return principal;
  },
);
