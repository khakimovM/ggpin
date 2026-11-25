import { Controller, Get, RequestMethod, type ExecutionContext } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ADMIN_AUTH_ROUTES } from '@repo/shared';
import { isAdminRoute } from '../../../common/auth/admin-route';
import { AdminAuthController } from '../auth/admin-auth.controller';
import { ADMIN_PUBLIC_KEY } from '../common/admin-public.decorator';
import { ADMIN_ROLES_KEY } from '../common/admin-role.decorator';
import { routeAllows } from '../common/admin.guard';

describe('routeAllows (fail closed; S1 matrix)', () => {
  it("a route without roles or permission is nobody's", () => {
    expect(routeAllows('OWNER', undefined, undefined)).toBe(false);
    expect(routeAllows('OWNER', [], undefined)).toBe(false);
  });

  it('roles list', () => {
    expect(routeAllows('SUPPORT', ['OWNER', 'OPERATOR', 'SUPPORT'], undefined)).toBe(true);
    expect(routeAllows('SUPPORT', ['OWNER'], undefined)).toBe(false);
  });

  it('a matrix action without order context uses adminMayPerform', () => {
    expect(routeAllows('SUPPORT', undefined, 'dashboard.read')).toBe(false);
    expect(routeAllows('OPERATOR', undefined, 'dashboard.read')).toBe(true);
    expect(routeAllows('OPERATOR', undefined, 'admins.read')).toBe(false);
  });

  it('an action that needs the order is role-checked here (the service decides the rest)', () => {
    expect(routeAllows('OPERATOR', undefined, 'orders.cancel')).toBe(true);
    expect(routeAllows('SUPPORT', undefined, 'orders.cancel')).toBe(false);
    expect(routeAllows('OPERATOR', undefined, 'orders.refund')).toBe(false);
  });
});

function contextOf(controller: object, handler: string): ExecutionContext {
  const proto = (controller as { prototype: Record<string, unknown> }).prototype;
  return {
    getType: () => 'http',
    getClass: () => controller,
    getHandler: () => proto[handler],
  } as unknown as ExecutionContext;
}

@Controller('admin/x')
class AdminLike {
  @Get('y')
  y(): void {}
}
@Controller('')
class RootLike {
  @Get('admin/z')
  z(): void {}
  @Get('administrator')
  a(): void {}
  @Get(['public', 'admin'])
  both(): void {}
}
@Controller(['payments', 'orders'])
class UserLike {
  @Get('admin')
  sub(): void {}
}

describe('isAdminRoute (from the matched handler, never the URL)', () => {
  it.each<[object, string, boolean]>([
    [AdminAuthController, 'me', true],
    [AdminAuthController, 'start', true],
    [AdminLike, 'y', true],
    [RootLike, 'z', true],
    [RootLike, 'a', false],
    [RootLike, 'both', true],
    [UserLike, 'sub', false],
  ])('%p.%s -> %s', (controller, handler, expected) => {
    expect(isAdminRoute(contextOf(controller, handler))).toBe(expected);
  });

  it('is false outside HTTP', () => {
    const context = { ...contextOf(AdminLike, 'y'), getType: () => 'rpc' } as ExecutionContext;
    expect(isAdminRoute(context)).toBe(false);
  });
});

describe('AdminAuthController matches ADMIN_AUTH_ROUTES (S1 single source)', () => {
  const proto = AdminAuthController.prototype as unknown as Record<string, object>;
  const base = String(Reflect.getMetadata(PATH_METADATA, AdminAuthController));
  const served = Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .map((name) => {
      const handler = proto[name] ?? {};
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;
      return {
        method: RequestMethod[method],
        path: `/${base}/${String(Reflect.getMetadata(PATH_METADATA, handler))}`,
        session: Reflect.getMetadata(ADMIN_PUBLIC_KEY, handler) !== true,
        rolesSet: Reflect.getMetadata(ADMIN_ROLES_KEY, handler) !== undefined,
      };
    });

  it('every route, its method and whether it needs a session', () => {
    const expected = ADMIN_AUTH_ROUTES.map((r) => ({
      method: r.method,
      path: r.path,
      session: r.session,
      rolesSet: r.session,
    }));
    const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
    expect([...served].sort(byPath)).toEqual([...expected].sort(byPath));
  });
});
