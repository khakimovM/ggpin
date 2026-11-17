import type { ExecutionContext } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';

/** First path segment of every admin route (`/api/v1/admin/*`, docs/04 «Admin»). */
export const ADMIN_ROUTE_SEGMENT = 'admin';

function declaredPaths(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [''];
}

function firstSegment(path: string): string | undefined {
  return path.split('/').find((segment) => segment !== '');
}

/**
 * True when the matched handler is part of the admin surface: its declared path (controller +
 * handler) starts with the `admin` segment. Decided from route metadata, never from the request
 * URL: the router decodes percent-escapes (`/api/v1/%61dmin/...` reaches an admin handler), so a
 * URL-prefix test could be dodged, while the handler that actually runs cannot. A handler with
 * several declared paths counts as admin when any of them is (the stricter guard wins).
 */
export function isAdminRoute(context: ExecutionContext): boolean {
  if (context.getType() !== 'http') return false;
  const controller = declaredPaths(Reflect.getMetadata(PATH_METADATA, context.getClass()));
  const handler = declaredPaths(Reflect.getMetadata(PATH_METADATA, context.getHandler()));
  return controller.some((c) =>
    handler.some((h) => firstSegment(`${c}/${h}`) === ADMIN_ROUTE_SEGMENT),
  );
}
