import type { DestinationStream } from 'pino';
import { pinoHttp, type Options } from 'pino-http';
import { REDACTED } from '@repo/shared';
import { buildLoggerParams } from '../logger-params';
import { CaptureStream } from './capture-stream';

// Distinct, greppable values: if one appears in the captured output, the policy leaked.
// Joined at runtime so the source never holds a literal that secret scanners report.
const fake = (...parts: string[]) => parts.join('-');
const SECRETS = {
  bearer: fake('bearer', 'secret', 'aaa111'),
  cookie: `sid=${fake('cookie', 'secret', 'bbb222')}`,
  initData: `query_id=${fake('initdata', 'secret', 'ccc333')}&hash=deadbeef`,
  signature: fake('signature', 'secret', 'ddd444'),
  mnemonic: `${fake('mnemonic', 'secret', 'eee555')} word word`,
  apiKey: fake('apikey', 'secret', 'fff666'),
  phone: '+998901234567',
  otp: '482913',
  webhook: fake('webhook', 'secret', 'ggg777'),
  refresh: fake('refresh', 'secret', 'hhh888'),
};

function createLogger(level: 'info' | 'debug' | 'silent' = 'info') {
  const stream = new CaptureStream();
  const params = buildLoggerParams({ LOG_LEVEL: level, NODE_ENV: 'test' }, stream);
  const [options, destination] = params.pinoHttp as [Options, DestinationStream];
  return { stream, logger: pinoHttp(options, destination).logger };
}

describe('API logger policy', () => {
  it('writes one JSON object per line with a label level, service and ISO time', () => {
    const { stream, logger } = createLogger();
    logger.info({ orderId: 'o-1' }, 'hello');
    const [record] = stream.records();
    expect(record).toMatchObject({ level: 'info', service: 'api', orderId: 'o-1', msg: 'hello' });
    expect(String(record?.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('never lets any kind of secret reach the output', () => {
    const { stream, logger } = createLogger();
    logger.info(
      {
        headers: {
          Authorization: `Bearer ${SECRETS.bearer}`,
          Cookie: SECRETS.cookie,
          'X-Telegram-Bot-Api-Secret-Token': SECRETS.webhook,
        },
        initData: SECRETS.initData,
        payment: { provider: 'click', signature: SECRETS.signature },
        wallet: { mnemonic: SECRETS.mnemonic },
        supplier: { apiKey: SECRETS.apiKey },
        user: { phone: SECRETS.phone },
        login: { otp: SECRETS.otp, refreshToken: SECRETS.refresh },
        list: [{ deeper: { token: SECRETS.bearer } }],
      },
      'diagnostic',
    );
    const out = stream.text();
    for (const value of Object.values(SECRETS)) expect(out).not.toContain(value);
    expect(out).toContain(REDACTED);
    expect(out).toContain('"provider":"click"');
  });

  it('keeps `code` fields: error envelopes and Node errors need them in logs', () => {
    const { stream, logger } = createLogger();
    logger.warn({ code: 'INSUFFICIENT_BALANCE', cause: { code: 'ECONNREFUSED' } }, 'rejected');
    expect(stream.records()[0]).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      cause: { code: 'ECONNREFUSED' },
    });
  });

  it('serialises errors with their stack, and scrubs secrets inside them', () => {
    const { stream, logger } = createLogger();
    const error = Object.assign(new Error('connect ECONNREFUSED redis://:hunter2@cache:6379'), {
      code: 'ECONNREFUSED',
      apiKey: SECRETS.apiKey,
    });
    logger.error({ err: error }, 'redis down');
    const out = stream.text();
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain(SECRETS.apiKey);
    const err = stream.records()[0]?.err as Record<string, unknown>;
    expect(err.type).toBe('Error');
    expect(err.code).toBe('ECONNREFUSED');
    expect(String(err.stack)).toContain('    at ');
  });

  it('scrubs credentials and tokens in free-text messages', () => {
    const { stream, logger } = createLogger();
    logger.warn(
      'connect failed postgresql://ggpin:hunter2@db:5432/ggpin?sslmode=require&token=abc',
    );
    const out = stream.text();
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('token=abc');
    expect(out).toContain('sslmode=require');
  });

  it('does not mutate the object the caller logged', () => {
    const { logger } = createLogger();
    const payload = { headers: { authorization: 'Bearer abc12345' } };
    logger.info(payload, 'x');
    expect(payload.headers.authorization).toBe('Bearer abc12345');
  });

  it('request/response serializers emit an allowlist only', () => {
    const { stream, logger } = createLogger();
    logger.info(
      {
        req: {
          id: 'req-1',
          method: 'POST',
          url: `/api/v1/cb?token=${SECRETS.bearer}`,
          headers: {
            authorization: `Bearer ${SECRETS.bearer}`,
            cookie: SECRETS.cookie,
            'user-agent': 'jest',
            'content-length': '12',
          },
          body: { initData: SECRETS.initData },
        },
        res: { statusCode: 201, headers: { 'set-cookie': SECRETS.cookie } },
      },
      'x',
    );
    expect(stream.records()[0]).toMatchObject({
      req: {
        id: 'req-1',
        method: 'POST',
        path: '/api/v1/cb',
        headers: { 'user-agent': 'jest', 'content-length': '12' },
      },
      res: { statusCode: 201 },
    });
    const out = stream.text();
    for (const value of Object.values(SECRETS)) expect(out).not.toContain(value);
  });

  it('respects LOG_LEVEL', () => {
    const { stream, logger } = createLogger('silent');
    logger.error('invisible');
    expect(stream.text()).toBe('');
  });

  it('only configures the pino-pretty transport in development', () => {
    const mention = (env: 'development' | 'production' | 'test') =>
      JSON.stringify(buildLoggerParams({ LOG_LEVEL: 'info', NODE_ENV: env })).includes(
        'pino-pretty',
      );
    expect(mention('development')).toBe(true);
    expect(mention('production')).toBe(false);
    expect(mention('test')).toBe(false);
    // A captured destination wins even in development, so tests never spawn a transport.
    expect(
      JSON.stringify(
        buildLoggerParams({ LOG_LEVEL: 'info', NODE_ENV: 'development' }, new CaptureStream()),
      ),
    ).not.toContain('pino-pretty');
  });
});
