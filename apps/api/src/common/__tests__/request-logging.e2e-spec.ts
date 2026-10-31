import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { REDACTED } from '@repo/shared';
import { CaptureStream } from '../logging/__tests__/capture-stream';
import { createHttpTestApp } from './create-http-test-app';

const BASE = '/api/v1/pipeline-test';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Greppable values: any appearance in the captured log output is a leak (AC5).
const SECRETS = {
  bearer: 'e2e-bearer-secret-111',
  cookie: 'e2e-cookie-secret-222',
  webhook: 'e2e-webhook-secret-333',
  queryToken: 'e2e-query-token-444',
  queryNonce: 'e2e-query-nonce-555',
  initData: 'e2e-initdata-secret-666',
  signature: 'e2e-signature-secret-777',
  mnemonic: 'e2e-mnemonic-secret-888',
  redisPassword: 'e2e-redis-password-999',
  dbPassword: 'e2e-db-password-000',
};

// One app for the file: nestjs-pino keeps a process-wide root logger, so the capture stream
// is fixed when the first app is built.
describe('request logging, request id and log redaction (real pipeline)', () => {
  const logs = new CaptureStream();
  let app: NestFastifyApplication;
  const http = () => request(app.getHttpServer());

  let bootOutput = '';

  beforeAll(async () => {
    // Passwords in the connection URLs are the guard: no boot or request line may print them.
    app = await createHttpTestApp({
      env: {
        LOG_LEVEL: 'info',
        REDIS_URL: `redis://:${SECRETS.redisPassword}@localhost:6379`,
        DATABASE_URL: `postgresql://ggpin:${SECRETS.dbPassword}@localhost:5432/ggpin_test`,
      },
      logDestination: logs,
    });
    bootOutput = logs.text();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => logs.clear());

  // Fastify runs onResponse after the socket write, so the client can see the response a tick
  // before the access line exists.
  const completed = async () => {
    for (let i = 0; i < 50; i += 1) {
      const lines = logs.records().filter((r) => r.msg === 'request completed');
      if (lines.length > 0) return lines;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return [];
  };

  it('boot logs are structured JSON, not Nest console text', () => {
    const lines = bootOutput.split('\n').filter((line) => line !== '');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
    expect(bootOutput).toContain('Nest application successfully started');
    expect(bootOutput).not.toContain(SECRETS.redisPassword);
    expect(bootOutput).not.toContain(SECRETS.dbPassword);
  });

  it('never logs secrets from headers, query string or body', async () => {
    const res = await http()
      .post(`${BASE}/sink?token=${SECRETS.queryToken}&nonce=${SECRETS.queryNonce}`)
      .set('Authorization', `Bearer ${SECRETS.bearer}`)
      .set('Cookie', `sid=${SECRETS.cookie}`)
      .set('X-Telegram-Bot-Api-Secret-Token', SECRETS.webhook)
      .send({
        initData: SECRETS.initData,
        payment: { signature: SECRETS.signature },
        mnemonic: SECRETS.mnemonic,
      })
      .expect(201);

    const out = logs.text();
    expect(out).not.toBe('');
    for (const value of Object.values(SECRETS)) expect(out).not.toContain(value);

    const [line] = await completed();
    expect(line).toMatchObject({
      level: 'info',
      method: 'POST',
      route: `${BASE}/sink`,
      status: 201,
      reqId: res.headers['x-request-id'],
    });
    expect(typeof line?.durationMs).toBe('number');
    expect(typeof line?.ip).toBe('string');
    // The access line is an allowlist: no body, query or header maps.
    expect(Object.keys(line ?? {})).not.toEqual(
      expect.arrayContaining(['body', 'query', 'headers', 'req']),
    );
  });

  it('echoes a well-formed incoming X-Request-Id and logs it', async () => {
    const res = await http().get(`${BASE}/ok`).set('X-Request-Id', 'client-req-12345').expect(200);
    expect(res.headers['x-request-id']).toBe('client-req-12345');
    expect((await completed())[0]).toMatchObject({ reqId: 'client-req-12345', status: 200 });
  });

  it('replaces a malformed incoming X-Request-Id with a generated UUID', async () => {
    const res = await http()
      .get(`${BASE}/ok`)
      .set('X-Request-Id', 'bad id with spaces')
      .expect(200);
    const id = res.headers['x-request-id'];
    expect(id).toMatch(UUID);
    expect(logs.text()).not.toContain('bad id with spaces');
    expect((await completed())[0]).toMatchObject({ reqId: id });
  });

  it('puts X-Request-Id on error responses and 404s too', async () => {
    const notFound = await http().get('/api/v1/nope?secret=e2e-query-token-444').expect(404);
    expect(notFound.headers['x-request-id']).toMatch(UUID);
    const invalid = await http().post(`${BASE}/echo`).send({ amount: 'x' }).expect(400);
    expect(invalid.headers['x-request-id']).toMatch(UUID);
    const domain = await http().get(`${BASE}/domain-error`).expect(422);
    expect(domain.headers['x-request-id']).toMatch(UUID);

    // Unmatched paths are logged without their query string.
    const unmatched = (await completed()).find((r) => r.route === 'unmatched');
    expect(unmatched).toMatchObject({ status: 404, path: '/api/v1/nope', level: 'warn' });
    expect(logs.text()).not.toContain(SECRETS.queryToken);
  });

  it('a 500 logs the stack server-side with the request id; the client gets no stack', async () => {
    const res = await http().get(`${BASE}/boom`).expect(500);
    const id = res.headers['x-request-id'];
    expect(res.body).toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'errors.INTERNAL_ERROR' },
    });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(JSON.stringify(res.body)).not.toMatch(/\bat\b.*\.ts/);

    const failure = logs.records().find((r) => r.msg === 'request failed');
    expect(failure).toMatchObject({
      level: 'error',
      reqId: id,
      method: 'GET',
      route: `${BASE}/boom`,
    });
    const err = failure?.err as Record<string, unknown>;
    expect(err.type).toBe('Error');
    expect(String(err.stack)).toContain('    at ');
    // The driver text quotes a connection URL; the password must not survive into the log.
    expect(logs.text()).not.toContain('hunter2');
    expect(String(err.message)).toContain(REDACTED);
    expect((await completed())[0]).toMatchObject({ status: 500, level: 'error', reqId: id });
  });

  it('does not log successful health probes at info, but still sets the request id', async () => {
    const res = await http().get('/api/v1/health/live').expect(200);
    expect(res.headers['x-request-id']).toMatch(UUID);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(logs.records().filter((r) => r.msg === 'request completed')).toEqual([]);
  });
});
