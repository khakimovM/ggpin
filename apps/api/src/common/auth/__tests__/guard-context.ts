import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthRequest } from '../auth-user';

export interface FakeRequestInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly cookies?: Record<string, string>;
  readonly authUser?: AuthRequest['authUser'];
}

export function fakeRequest(init: FakeRequestInit = {}): AuthRequest {
  return {
    method: init.method ?? 'GET',
    headers: init.headers ?? {},
    ...(init.cookies !== undefined ? { cookies: init.cookies } : {}),
    ...(init.authUser !== undefined ? { authUser: init.authUser } : {}),
  };
}

class FakeController {}

/**
 * A minimal ExecutionContext around a request. `metadata` is what the real Reflector will find
 * on the handler (key -> value), which is how @Public() / @SkipCsrf() are simulated without a
 * router. Each call gets its own handler function, so metadata never leaks between tests.
 */
export function fakeContext(
  request: AuthRequest,
  metadata: Readonly<Record<string, unknown>> = {},
): { context: ExecutionContext; reflector: Reflector } {
  const handler = (): void => undefined;
  for (const [key, value] of Object.entries(metadata)) {
    Reflect.defineMetadata(key, value, handler);
  }
  const context = {
    getHandler: () => handler,
    getClass: () => FakeController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, reflector: new Reflector() };
}
