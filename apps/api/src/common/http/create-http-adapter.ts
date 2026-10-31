import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { AppConfig } from '../../config/config.module';
import { generateRequestId } from '../logging/request-id';
import { BODY_LIMIT_BYTES } from './http-limits';

// Used by main.ts and by the e2e tests, so the adapter options that shape behaviour
// (proxy trust => request.ip => rate-limit key, body limit => 413) are the shipped ones.
export function createHttpAdapter(config: AppConfig): FastifyAdapter {
  // A hop count: Fastify then takes the address the last trusted proxy appended, never one the
  // client wrote. 0 ignores X-Forwarded-For entirely.
  // (Nest's adapter type has no number form, so the count is passed as the equivalent
  // function: trust hop i while i < count.)
  const hops = config.TRUST_PROXY;
  const trustProxy = hops > 0 ? (_address: string, hop: number) => hop < hops : false;
  // genReqId: Fastify assigns request.id before any hook or middleware runs, so this is the one
  // place the request id is decided (nestjs-pino's own genReqId is ignored under Fastify).
  return new FastifyAdapter({
    trustProxy,
    bodyLimit: BODY_LIMIT_BYTES,
    genReqId: generateRequestId,
  });
}
