import { RequestMethod, type Type } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  ADMIN_AUTH_ROUTES,
  ADMIN_PERMISSION_KEYS,
  ADMIN_PERMISSIONS,
  type AdminPermission,
} from '@repo/shared';
import { ADMIN_ACTION_KEY } from '../common/admin-action.decorator';
import { AdminFallbackController } from '../common/admin-fallback.controller';
import { AdminModule } from '../admin.module';

// SA-S4-4 / CR n2: the routes the app serves and the shared role matrix are one list. Every
// handler of AdminModule (what Nest's DiscoveryService would list: the module's controllers and
// their route metadata) either performs exactly the matrix permission whose routes name it, or is
// a login-flow route; and every READ route of the matrix is served except the exact list S4 did
// not take on (the slice that serves one removes it here). Write routes arrive with S5-S8.

interface Served {
  readonly route: string;
  readonly permission: AdminPermission | undefined;
}

const key = (method: string, path: string): string => `${method} ${path}`;

/** Matrix read routes outside S4 (orders: the orders slice; infra wallet/fragment/adapters). */
const READS_NOT_YET_SERVED = [
  'GET /admin/orders',
  'GET /admin/orders/review-queue',
  'GET /admin/orders/:id',
  'GET /admin/infra/wallet',
  'GET /admin/infra/fragment',
  'GET /admin/infra/adapters',
];

function joinPath(...parts: unknown[]): string {
  const segments = parts
    .flatMap((part) => (typeof part === 'string' ? part.split('/') : []))
    .filter((segment) => segment !== '');
  return `/${segments.join('/')}`;
}

function servedRoutes(): Served[] {
  const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AdminModule) ??
    []) as Type[];
  const served: Served[] = [];
  for (const controller of controllers) {
    if (controller === AdminFallbackController) continue;
    const base: unknown = Reflect.getMetadata(PATH_METADATA, controller);
    const proto = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
      if (typeof method !== 'number') continue;
      const verb = RequestMethod[method] ?? `method#${String(method)}`;
      const path = joinPath(base, Reflect.getMetadata(PATH_METADATA, handler));
      served.push({
        route: key(verb, path),
        permission: Reflect.getMetadata(ADMIN_ACTION_KEY, handler) as AdminPermission | undefined,
      });
    }
  }
  return served;
}

describe('admin routes vs the shared matrix', () => {
  const served = servedRoutes();
  const matrix = new Map<string, AdminPermission>();
  for (const permission of ADMIN_PERMISSION_KEYS) {
    for (const route of ADMIN_PERMISSIONS[permission].routes) {
      matrix.set(key(route.method, route.path), permission);
    }
  }
  const auth = new Set(ADMIN_AUTH_ROUTES.map((route) => key(route.method, route.path)));

  it('finds the handlers (the read controllers are many)', () => {
    expect(served.length).toBeGreaterThan(30);
  });

  it('every handler: its @AdminAction is the permission the matrix gives its (method, path)', () => {
    const wrong = served
      .filter((row) => row.permission !== undefined || !auth.has(row.route))
      .filter((row) => matrix.get(row.route) !== row.permission)
      .map((row) => `${row.route}: ${String(row.permission)} vs ${String(matrix.get(row.route))}`);
    expect(wrong).toEqual([]);
  });

  it('a handler without @AdminAction is a login-flow route, and each of those is served', () => {
    const bare = served.filter((row) => row.permission === undefined).map((row) => row.route);
    expect(bare.sort()).toEqual([...auth].sort());
  });

  it('every read route of the matrix is served but the listed ones; the rest unserved are writes', () => {
    const servedSet = new Set(served.map((row) => row.route));
    const missing = [...matrix].filter(([route]) => !servedSet.has(route));
    const reads = missing.filter(([, permission]) => !ADMIN_PERMISSIONS[permission].write);
    expect(reads.map(([route]) => route).sort()).toEqual([...READS_NOT_YET_SERVED].sort());
  });

  it('no route is served twice', () => {
    const routes = served.map((row) => row.route);
    expect(new Set(routes).size).toBe(routes.length);
  });
});
