import { SetMetadata } from '@nestjs/common';
import type { AdminRole } from '@repo/shared';

export const ADMIN_ROLES_KEY = 'ggpin:admin-roles';

/**
 * The roles that may call a route that is not a matrix action (e.g. `auth/me`, `auth/logout`:
 * every role). A session route without this or @AdminAction is refused for everyone
 * (AdminGuard fails closed).
 */
export const AdminRoles = (...roles: readonly AdminRole[]): ClassDecorator & MethodDecorator =>
  SetMetadata(ADMIN_ROLES_KEY, roles);
