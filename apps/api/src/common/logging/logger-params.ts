import type { Params } from 'nestjs-pino';
import { stdTimeFunctions, type DestinationStream } from 'pino';
import type { Options } from 'pino-http';
import { redactLogRecord, redactSecrets, scrubSecretsInText } from '@repo/shared';
import type { AppConfig } from '../../config/config.module';
import { serializeRequest, serializeResponse } from './serializers';

// Records are redacted by formatters.log, except these keys: their serializers below output
// a small allowlisted shape and redact it themselves, so copying the live objects first
// would only cost time.
const SERIALIZED_KEYS: ReadonlySet<string> = new Set(['req', 'res', 'err']);

export type LoggerConfig = Pick<AppConfig, 'LOG_LEVEL' | 'NODE_ENV'>;

// Built once in AppModule and shared by the HTTP and the out-of-request logger, so a line
// logged at boot and a line logged inside a request go through the same policy.
//
// Redaction is the SECOND line of defence. The first is not logging secrets at all: request
// bodies, raw headers and query strings are never passed to the logger (see serializers.ts
// and request-logging.ts).
//
// Why formatters.log + serializers and not Pino's `redact` option: `redact` takes fixed paths
// ("a.b.c" or one wildcard level), so a secret under an unexpected key or depth would pass.
// The shared policy matches key names at any depth.
export function buildLoggerParams(config: LoggerConfig, destination?: DestinationStream): Params {
  // pino-pretty is a devDependency: production and test builds never reference it. A
  // caller-supplied destination (tests) bypasses transports entirely.
  const pretty = config.NODE_ENV === 'development' && destination === undefined;
  const options: Options = {
    level: config.LOG_LEVEL,
    base: { service: 'api' },
    timestamp: stdTimeFunctions.isoTime,
    formatters: {
      log: (record) => redactLogRecord(record, SERIALIZED_KEYS),
      // pino-pretty reads numeric levels; JSON consumers prefer labels.
      ...(pretty ? {} : { level: (label: string) => ({ level: label }) }),
    },
    serializers: {
      req: serializeRequest,
      res: serializeResponse,
      err: redactSecrets,
      // A message such as `connect failed redis://user:pw@host` is free text.
      msg: (message: unknown) =>
        typeof message === 'string' ? scrubSecretsInText(message) : message,
    },
    // pino-http only builds the per-request child logger here (request id on every line a
    // service logs); the access line is written by request-logging.ts, which knows the
    // matched route pattern and the trust-proxy aware client IP.
    autoLogging: false,
    quietReqLogger: true,
    quietResLogger: true,
    // Our serializers take the raw request/response, not pino-std-serializers' wrapped form.
    wrapSerializers: false,
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname,service',
            },
          },
        }
      : {}),
  };
  return { pinoHttp: destination === undefined ? options : [options, destination] };
}
