import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { AppConfig } from '../../config/config.module';
import { generateRequestId } from '../logging/request-id';
import { BODY_LIMIT_BYTES } from './http-limits';

// Used by main.ts and by the e2e tests, so the adapter options that shape behaviour
// (proxy trust => request.ip => rate-limit key, body limit => 413) are the shipped ones.
export function createHttpAdapter(config: AppConfig): FastifyAdapter {
  // TRUST_PROXY is an allowlist of proxy IPs/CIDRs (see config/trust-proxy.ts). Fastify then
  // reads X-Forwarded-For only when the TCP peer is on the list, and takes the right-most
  // address that is not itself a trusted proxy, never one the client wrote on the left. A peer
  // that is not listed (a client that reaches the API directly) cannot influence request.ip.
  // Empty list = `false`: X-Forwarded-For is ignored entirely.
  const trustProxy = config.TRUST_PROXY.length > 0 ? [...config.TRUST_PROXY] : false;
  // genReqId: Fastify assigns request.id before any hook or middleware runs, so this is the one
  // place the request id is decided (nestjs-pino's own genReqId is ignored under Fastify).
  return new FastifyAdapter({
    trustProxy,
    bodyLimit: BODY_LIMIT_BYTES,
    genReqId: generateRequestId,
  });
}
