import { Logger as NestLogger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { pinoHttp, type Options } from 'pino-http';
import { REDACTED } from '@repo/shared';
import { withFakeInfra } from '../../__tests__/fake-infra';
import { buildTestEnv } from '../../config/__tests__/test-env';
import { WorkerModule } from '../../worker.module';
import { buildLoggerParams } from '../logger-params';
import { CaptureStream } from './capture-stream';

// Distinct, greppable values: if one appears in the captured output, the policy leaked.
// Joined at runtime so the source never holds a literal that secret scanners report.
const fake = (...parts: string[]) => parts.join('-');
const SECRETS = {
  mnemonic: ['abandon', 'ability', 'able', 'about', 'above', 'absent'].join(' '),
  apiKey: fake('supplier', 'apikey', 'secret', '111'),
  cookies: `stel_ssid=${fake('fragment', 'cookie', 'secret', '222')}`,
  privateKey: fake('wallet', 'privatekey', 'secret', '333'),
  walletKey: fake('enc', 'key', 'secret', '444'),
  signature: fake('supplier', 'signature', 'secret', '555'),
  token: fake('api', 'token', 'secret', '666'),
};

function createLogger(level: 'info' | 'silent' = 'info') {
  const stream = new CaptureStream();
  const params = buildLoggerParams({ LOG_LEVEL: level, NODE_ENV: 'test' }, stream);
  const [options, destination] = params.pinoHttp as [Options, DestinationStream];
  return { stream, logger: pinoHttp(options, destination).logger };
}

describe('worker logger policy', () => {
  it('writes one JSON object per line with a label level and service', () => {
    const { stream, logger } = createLogger();
    logger.info({ orderId: 'o-1' }, 'job started');
    expect(stream.records()[0]).toMatchObject({
      level: 'info',
      service: 'worker',
      orderId: 'o-1',
      msg: 'job started',
    });
  });

  it('never lets wallet or supplier secrets reach the output', () => {
    const { stream, logger } = createLogger();
    logger.info(
      {
        wallet: { mnemonic: SECRETS.mnemonic, privateKey: SECRETS.privateKey },
        fragment: { cookies: [{ name: 'stel_ssid', value: SECRETS.cookies }] },
        supplier: { apiKey: SECRETS.apiKey, response: { signature: SECRETS.signature } },
        env: {
          WALLET_ENC_KEY: SECRETS.walletKey,
          TON_MNEMONIC_ENC: SECRETS.mnemonic,
          FRAGMENT_SESSION_ENC_KEY: SECRETS.walletKey,
          TON_API_KEY: SECRETS.apiKey,
          RESELLER_STARS_API_KEY: SECRETS.apiKey,
          accessToken: SECRETS.token,
        },
        steps: [{ attempt: 1, auth: { token: SECRETS.token } }],
      },
      'dump',
    );
    const out = stream.text();
    for (const value of Object.values(SECRETS)) expect(out).not.toContain(value);
    expect(out).toContain(REDACTED);
    expect(out).toContain('"attempt":1');
  });

  it('redacts child-logger bindings, which do not pass through the record formatter', () => {
    const { stream, logger } = createLogger();
    const child = logger.child({ apiKey: SECRETS.apiKey, orderId: 'o-3', ctx: { cookies: 'c=1' } });
    child.info('bound');
    child.child({ secretKey: SECRETS.walletKey }).info({ attempt: 2 }, 'nested child');
    const out = stream.text();
    expect(out).not.toContain(SECRETS.apiKey);
    expect(out).not.toContain(SECRETS.walletKey);
    expect(out).not.toContain('c=1');
    expect(stream.records()[0]).toMatchObject({
      service: 'worker',
      orderId: 'o-3',
      apiKey: REDACTED,
      msg: 'bound',
    });
    expect(stream.records()[1]).toMatchObject({ orderId: 'o-3', attempt: 2, secretKey: REDACTED });
  });

  it('keeps useful non-secret fields and redacts an OTP-shaped code', () => {
    const { stream, logger } = createLogger();
    logger.info(
      { idempotencyKey: 'k-1', txHash: 'h-1', jobId: 'j-1', queue: 'fulfill-order', code: 4821 },
      'fields',
    );
    logger.error({ err: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }) }, 'fields');
    expect(stream.records()[0]).toMatchObject({
      idempotencyKey: 'k-1',
      txHash: 'h-1',
      jobId: 'j-1',
      queue: 'fulfill-order',
      code: REDACTED,
    });
    expect((stream.records()[1] as { err: { code: string } }).err.code).toBe('ETIMEDOUT');
  });

  it('keeps `code` and scrubs secrets inside logged errors', () => {
    const { stream, logger } = createLogger();
    const error = Object.assign(new Error('fragment call failed https://u:p4ss@fragment.test/x'), {
      code: 'ETIMEDOUT',
      apiKey: SECRETS.apiKey,
      response: { headers: { cookie: SECRETS.cookies } },
    });
    logger.error({ err: error, orderId: 'o-2' }, 'fulfill failed');
    const out = stream.text();
    expect(out).not.toContain('p4ss');
    expect(out).not.toContain(SECRETS.apiKey);
    expect(out).not.toContain(SECRETS.cookies);
    const record = stream.records()[0] as { err: Record<string, unknown>; orderId: string };
    expect(record.orderId).toBe('o-2');
    expect(record.err.code).toBe('ETIMEDOUT');
    expect(String(record.err.stack)).toContain('    at ');
  });

  it('scrubs credentials and bot tokens in free-text messages', () => {
    const { stream, logger } = createLogger();
    logger.warn('redis://:hunter2@cache:6379 refused, retry with token=abc123');
    const out = stream.text();
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('token=abc123');
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
  });
});

// The real module graph: existing `new Logger(...)` call sites keep working, come out as
// structured JSON, and no connection URL credential appears anywhere in the output.
describe('worker logging through the Nest logger', () => {
  it('routes Nest Logger calls through Pino and never prints connection credentials', async () => {
    const stream = new CaptureStream();
    const env = buildTestEnv({
      REDIS_URL: 'redis://:redis-pw-secret@example.test:6380',
      DATABASE_URL: 'postgresql://ggpin:db-pw-secret@localhost:5432/ggpin_test',
    });
    const moduleRef = await withFakeInfra(
      Test.createTestingModule({
        imports: [WorkerModule.register(env, { logDestination: stream })],
      }),
    ).compile();
    moduleRef.useLogger(moduleRef.get(Logger));
    await moduleRef.init();

    new NestLogger('Queue').warn('queue fulfill-order: connect ECONNREFUSED 127.0.0.1:6379');
    new NestLogger('Worker').error('boom', 'Error: boom\n    at somewhere (file.ts:1:1)');
    await moduleRef.close();

    const records = stream.records();
    expect(records).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        service: 'worker',
        context: 'Queue',
        msg: 'queue fulfill-order: connect ECONNREFUSED 127.0.0.1:6379',
      }),
    );
    const out = stream.text();
    expect(out).not.toContain('redis-pw-secret');
    expect(out).not.toContain('db-pw-secret');
  });
});
