import { Readable } from 'node:stream';
import {
  Injectable,
  StreamableFile,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import { RAW_RESPONSE_KEY } from './raw-response.decorator';
import { toJsonSafe } from './to-json-safe';
import { WithMeta } from './with-meta';

export interface SuccessEnvelope {
  readonly success: true;
  readonly data: unknown;
  readonly meta?: unknown;
}

function isBinaryPayload(value: unknown): boolean {
  return (
    value instanceof StreamableFile ||
    value instanceof Readable ||
    Buffer.isBuffer(value) ||
    value instanceof ArrayBuffer
  );
}

// Wraps every successful result as `{ success: true, data, meta? }` (docs/04-API-CONTRACT.md)
// and turns BigInt into strings on the way out. `undefined` becomes `data: null` so the key
// is always present (JSON.stringify would silently drop `undefined`).
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const raw = this.reflector.getAllAndOverride<boolean | undefined>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (raw === true) return next.handle();

    return next.handle().pipe(
      map((result: unknown): unknown => {
        if (isBinaryPayload(result)) return result;
        if (result instanceof WithMeta) {
          const envelope: SuccessEnvelope = {
            success: true,
            data: toJsonSafe(result.data),
            meta: toJsonSafe(result.meta),
          };
          return envelope;
        }
        const envelope: SuccessEnvelope = { success: true, data: toJsonSafe(result ?? null) };
        return envelope;
      }),
    );
  }
}
