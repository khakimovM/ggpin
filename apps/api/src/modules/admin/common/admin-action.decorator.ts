import { SetMetadata } from '@nestjs/common';
import type { AdminPermission } from '@repo/shared';

export const ADMIN_ACTION_KEY = 'ggpin:admin-action';

/**
 * The ADMIN_PERMISSIONS key a route performs. AdminGuard checks it with `adminMayPerform` for
 * actions that need no order context; for those that do (an OPERATOR limit or an owner-only
 * HELD order), the guard only checks the role and the service repeats `adminMayPerform` with the
 * order it locked (fail-closed: S1 refuses an OPERATOR without that context).
 */
export const AdminAction = (permission: AdminPermission): MethodDecorator =>
  SetMetadata(ADMIN_ACTION_KEY, permission);
