import type { Params } from 'nestjs-pino';
import { stdTimeFunctions, symbols, type DestinationStream } from 'pino';
import type { Options } from 'pino-http';
import {
  redactChildBindings,
  redactLogRecord,
  redactSecrets,
  scrubSecretsInText,
} from '@repo/shared';
import type { WorkerConfig } from '../config/config.module';

// `err` is redacted by its own serializer, so the record formatter skips it.
const SERIALIZED_KEYS: ReadonlySet<string> = new Set(['err']);

export type LoggerConfig = Pick<WorkerConfig, 'LOG_LEVEL' | 'NODE_ENV'>;

// Same policy as apps/api (shared redaction in @repo/shared), without the HTTP parts: the
// worker has no requests, so no request id; jobs carry orderId in their own log fields.
//
// This is the process that holds the TON mnemonic, Fragment cookies and supplier keys, so
// the rule is: never log them, and if one is logged by mistake, under any key at any depth,
// it must not reach the output. Pino's `redact` option only covers fixed paths, hence the
// deep, name-based policy.
export function buildLoggerParams(config: LoggerConfig, destination?: DestinationStream): Params {
  // pino-pretty is a devDependency: production and test builds never reference it. A
  // caller-supplied destination (tests) bypasses transports entirely.
  const pretty = config.NODE_ENV === 'development' && destination === undefined;
  const options: Options = {
    level: config.LOG_LEVEL,
    base: { service: 'worker' },
    timestamp: stdTimeFunctions.isoTime,
    formatters: {
      log: (record) => redactLogRecord(record, SERIALIZED_KEYS),
      // Root bindings (`base`). Pino resets this formatter for child loggers, see onChild.
      bindings: (bindings) => redactLogRecord(bindings, SERIALIZED_KEYS),
      // pino-pretty reads numeric levels; JSON consumers prefer labels.
      ...(pretty ? {} : { level: (label: string) => ({ level: label }) }),
    },
    // `logger.child({ apiKey })` is printed on every line the child writes and bypasses both
    // `formatters.log` and `formatters.bindings`; this rewrites the child's stored bindings.
    onChild: (child) => redactChildBindings(child, symbols.chindingsSym),
    serializers: {
      err: redactSecrets,
      // A message such as `connect failed redis://user:pw@host` is free text.
      msg: (message: unknown) =>
        typeof message === 'string' ? scrubSecretsInText(message) : message,
    },
    // No HTTP in the worker; these only keep nestjs-pino from doing request work if a
    // middleware were ever mounted.
    autoLogging: false,
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
