import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ADMIN_PERMISSIONS,
  adminMayPerform,
  roleHas,
  type AdminPermission,
  type AdminRole,
} from '@repo/shared';
import { isAdminRoute } from '../../../common/auth/admin-route';
import { AppError } from '../../../common/exceptions/app-error';
import { ADMIN_ACTION_KEY } from './admin-action.decorator';
import { ADMIN_PUBLIC_KEY } from './admin-public.decorator';
import { isWriteMethod, type AdminRequest } from './admin-request';
import { AdminRequestGate } from './admin-request-gate';
import { ADMIN_ROLES_KEY } from './admin-role.decorator';
import { AdminThrottle } from './admin-throttle';

/**
 * May `role` call a route with this metadata. No metadata = nobody (fail closed). A matrix action
 * that needs an order to decide (an OPERATOR limit, owner-only HELD orders) is only role-checked
 * here; its service repeats `adminMayPerform` with the order it locked.
 */
export function routeAllows(
  role: AdminRole,
  roles: readonly AdminRole[] | undefined,
  permission: AdminPermission | undefined,
): boolean {
  if (permission !== undefined) {
    const rule = ADMIN_PERMISSIONS[permission];
    const needsOrder = rule.operatorLimit || rule.ownerOnlyHolds.length > 0;
    return needsOrder ? roleHas(role, permission) : adminMayPerform(role, permission);
  }
  return roles !== undefined && roles.includes(role);
}

// Global guard (AdminModule), after AdminCsrfGuard; non-admin routes pass untouched. Every admin
// request that is not a login route, on every call (docs/04 «Tekshiruv tartibi», D-63 (3)):
//   exactly one admin cookie -> a live session (not revoked, under 8 h, used within 1 h)
//   -> AdminUser.isActive -> telegramId in ADMIN_TELEGRAM_IDS (config) -> per-session limits
//   -> the route's roles / permission, against the role read from the database just now.
// A user cookie or a Bearer token is never read here. Every refusal is the same 404 (D-26), and
// the guard never sets or clears a cookie, so refusals cannot be told apart by their headers.
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly gate: AdminRequestGate,
    private readonly throttle: AdminThrottle,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!isAdminRoute(context)) return true;
    const handler = context.getHandler();
    if (this.reflector.get<boolean | undefined>(ADMIN_PUBLIC_KEY, handler) === true) return true;

    const request = context.switchToHttp().getRequest<AdminRequest>();
    const principal = await this.gate.principal(request);
    if (principal === null) return this.throttle.refuseAnonymous(request.ip);

    await this.throttle.countSession(principal.sessionId, isWriteMethod(request.method));
    const targets = [handler, context.getClass()];
    const roles = this.reflector.getAllAndOverride<readonly AdminRole[] | undefined>(
      ADMIN_ROLES_KEY,
      targets,
    );
    const permission = this.reflector.getAllAndOverride<AdminPermission | undefined>(
      ADMIN_ACTION_KEY,
      targets,
    );
    if (!routeAllows(principal.admin.role, roles, permission)) throw new AppError('NOT_FOUND');
    request.adminPrincipal = principal;
    return true;
  }
}
