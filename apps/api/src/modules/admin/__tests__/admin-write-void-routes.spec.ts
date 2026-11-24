import { RequestMethod, type DynamicModule, type Type } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  ADMIN_KEYED_WRITE_PERMISSIONS,
  ADMIN_PERMISSIONS,
  type AdminKeyedWritePermission,
  type AdminPermission,
} from '@repo/shared';
import { AppModule } from '../../../app.module';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import { ADMIN_ACTION_KEY } from '../common/admin-action.decorator';
import { VOID_ROUTE_CASES } from './admin-write-void.e2e-table';

// 9-B SA-1 static check (SA-9B1-2, CR nit #9): every keyed admin write served ANYWHERE in the
// app (the whole module tree from AppModule, not only AdminModule) has a row in the void table
// (admin-write-void-routes.e2e-spec.ts), each row is its permission's matrix route, and no
// permission is served by two handlers. A new keyed route without a row fails here, so "a voided
// key answers 409 and a late commit loses" is proven for every route, not a sample.

const KEYED: ReadonlySet<string> = new Set(ADMIN_KEYED_WRITE_PERMISSIONS);

function isKeyed(permission: AdminPermission | undefined): permission is AdminKeyedWritePermission {
  return permission !== undefined && KEYED.has(permission);
}

type ModuleRef = Type | DynamicModule | { forwardRef: () => Type } | undefined;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** Every controller class of the module tree under `root` (static and dynamic imports). */
function controllersOf(root: ModuleRef): Set<Type> {
  const seen = new Set<unknown>();
  const found = new Set<Type>();
  const visit = (ref: ModuleRef): void => {
    if (ref === undefined) return;
    if ('forwardRef' in ref) return visit(ref.forwardRef());
    const dynamic = 'module' in ref ? ref : undefined;
    const type = dynamic === undefined ? (ref as Type) : dynamic.module;
    const key = dynamic ?? type;
    if (seen.has(key)) return;
    seen.add(key);
    const meta = (name: string): unknown[] => asArray(Reflect.getMetadata(name, type));
    const controllers = [...meta(MODULE_METADATA.CONTROLLERS), ...asArray(dynamic?.controllers)];
    for (const controller of controllers) found.add(controller as Type);
    for (const child of [...meta(MODULE_METADATA.IMPORTS), ...asArray(dynamic?.imports)]) {
      visit(child as ModuleRef);
    }
  };
  visit(root);
  return found;
}

interface Served {
  readonly permission: AdminKeyedWritePermission;
  readonly route: string;
}

function servedKeyed(): Served[] {
  const served: Served[] = [];
  for (const controller of controllersOf(AppModule.register(buildTestEnv()))) {
    const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
    const proto = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
      const permission = Reflect.getMetadata(ADMIN_ACTION_KEY, handler) as
        AdminPermission | undefined;
      if (typeof method !== 'number' || !isKeyed(permission)) continue;
      const path = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
      const full = `/${[base, path].join('/')}`.replace(/\/+/g, '/').replace(/\/$/, '');
      served.push({ permission, route: `${RequestMethod[method] ?? '?'} ${full}` });
    }
  }
  return served;
}

describe('void route table vs the served keyed writes (whole app)', () => {
  const served = servedKeyed();

  it('finds the keyed writes (users, payments, cards, catalog, admins)', () => {
    expect(served.length).toBeGreaterThanOrEqual(23);
  });

  it('serves each keyed permission by one handler only', () => {
    const permissions = served.map((row) => row.permission);
    const twice = permissions.filter((p, i) => permissions.indexOf(p) !== i);
    expect(twice).toEqual([]);
  });

  it('has a row for every served keyed write, and none for a route that is not served', () => {
    const permissions = [...new Set(served.map((row) => row.permission))];
    expect(Object.keys(VOID_ROUTE_CASES).sort()).toEqual(permissions.sort());
  });

  it('each row is its permission’s matrix route, the one the handler serves', () => {
    for (const { permission, route } of served) {
      const row = VOID_ROUTE_CASES[permission];
      const matrix = ADMIN_PERMISSIONS[permission].routes[0];
      const expected = `${matrix?.method ?? ''} ${matrix?.path ?? ''}`;
      expect(`${row?.method ?? ''} /admin/${row?.route ?? ''}`).toBe(expected);
      expect(route).toBe(expected);
    }
  });
});
