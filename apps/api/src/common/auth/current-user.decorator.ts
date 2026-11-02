import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { AppError } from '../exceptions/app-error';
import type { AuthRequest, AuthUser } from './auth-user';

// `@CurrentUser()` -> the AuthUser, `@CurrentUser('id')` -> the user id. The only source of a
// userId for services (rules/10-backend-nestjs.md): never a body, query or path parameter.
// On a route without a session (a @Public() handler asking for the user) it fails closed.
export const CurrentUser = createParamDecorator(
  (field: keyof AuthUser | undefined, context: ExecutionContext): unknown => {
    const user = context.switchToHttp().getRequest<AuthRequest>().authUser;
    if (user === undefined) throw new AppError('UNAUTHORIZED');
    return field === undefined ? user : user[field];
  },
);
