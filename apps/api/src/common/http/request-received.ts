import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { performanceClock } from '../admin/admin-deadline';
import { AppError } from '../exceptions/app-error';

// When each request was received, on the monotonic clock (docs/04 «So‘rov deadline’i», 9-B M-1):
// the start of an admin write's 45 s deadline. Kept in a WeakMap keyed by the Fastify request
// (the object Nest hands to param decorators), so it needs no request decoration and leaves with
// the request.
const receivedAt = new WeakMap<object, number>();

/**
 * Registers the stamp as the FIRST onRequest hook (configureApp calls it before every other hook),
 * so the time a request spends in the later hooks, guards and body parsing counts too. The stamp
 * is `performance.now()`; the MONOTONIC_CLOCK the checks read is on that same timeline (tests add
 * an offset to it to move time past the deadline, never the wall clock).
 */
export function registerRequestReceived(app: NestFastifyApplication): void {
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (request, _reply, done) => {
      receivedAt.set(request, performanceClock.nowMs());
      done();
    });
}

/** The stamp of a request; a request the hook did not see is a server bug, never "no deadline". */
export function receivedAtOf(request: object): number {
  const at = receivedAt.get(request);
  if (at === undefined) throw new AppError('INTERNAL_ERROR');
  return at;
}

/** `@RequestReceivedAt()` -> the request's monotonic receive time, for AdminWriteSpec. */
export const RequestReceivedAt = createParamDecorator(
  (_data: unknown, context: ExecutionContext): number =>
    receivedAtOf(context.switchToHttp().getRequest<object>()),
);
