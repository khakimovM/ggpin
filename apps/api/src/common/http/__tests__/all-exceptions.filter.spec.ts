import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
  UnauthorizedException,
  type ArgumentsHost,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { ZodValidationException } from 'nestjs-zod';
import { z } from 'zod';
import { AppError } from '../../exceptions/app-error';
import { AllExceptionsFilter } from '../all-exceptions.filter';

interface Sent {
  status: number;
  body: unknown;
}

function run(exception: unknown): Sent {
  const sent: Sent = { status: 0, body: undefined };
  const reply = {
    status(code: number) {
      sent.status = code;
      return {
        send(payload: unknown) {
          sent.body = payload;
        },
      };
    },
  };
  const request = { method: 'POST', routeOptions: { url: '/api/v1/things' } };
  const host = {
    switchToHttp: () => ({ getResponse: () => reply, getRequest: () => request }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return sent;
}

function fastifyError(statusCode: number, code: string): Error {
  return Object.assign(new Error('internal fastify text'), { statusCode, code });
}

describe('AllExceptionsFilter', () => {
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('AppError -> its code, contract status and i18n key', () => {
    const sent = run(new AppError('QUOTE_EXPIRED'));
    expect(sent).toEqual({
      status: 410,
      body: { success: false, error: { code: 'QUOTE_EXPIRED', message: 'errors.QUOTE_EXPIRED' } },
    });
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('AppError details with BigInt are serialised as strings', () => {
    const sent = run(
      new AppError('INSUFFICIENT_BALANCE', { balance: 100n, required: 250n, shortfall: 150n }),
    );
    expect(sent.status).toBe(422);
    const body = sent.body as { error: { details: unknown } };
    expect(body.error.details).toEqual({ balance: '100', required: '250', shortfall: '150' });
    expect(() => JSON.stringify(sent.body)).not.toThrow();
  });

  it('Zod validation failure -> 400 VALIDATION_ERROR with path + code only', () => {
    const schema = z.object({ amount: z.string(), tags: z.array(z.number()) }).strict();
    const result = schema.safeParse({ amount: 12, tags: [1, 'secret-token'], extra: 'x' });
    expect(result.success).toBe(false);
    const sent = run(new ZodValidationException(result.error));
    expect(sent.status).toBe(400);
    const body = sent.body as {
      error: {
        code: string;
        message: string;
        details: { fields: { path: string; code: string }[] };
      };
    };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('errors.VALIDATION_ERROR');
    expect(body.error.details.fields).toEqual(
      expect.arrayContaining([
        { path: 'amount', code: 'invalid_type' },
        { path: 'tags.1', code: 'invalid_type' },
      ]),
    );
    for (const field of body.error.details.fields) {
      expect(Object.keys(field).sort()).toEqual(['code', 'path']);
    }
    expect(JSON.stringify(sent.body)).not.toContain('secret-token');
  });

  it('NotFoundException -> 404 NOT_FOUND without Nest text', () => {
    const sent = run(new NotFoundException('Cannot GET /nope'));
    expect(sent.status).toBe(404);
    expect(JSON.stringify(sent.body)).not.toContain('Cannot GET');
    expect(sent.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('ThrottlerException -> 429 RATE_LIMITED', () => {
    const sent = run(new ThrottlerException());
    expect(sent.status).toBe(429);
    expect(sent.body).toMatchObject({
      error: { code: 'RATE_LIMITED', message: 'errors.RATE_LIMITED' },
    });
  });

  it.each([
    [new UnauthorizedException(), 401, 'UNAUTHORIZED'],
    [new BadRequestException('bad uuid'), 400, 'VALIDATION_ERROR'],
    [new HttpException('big', 413), 413, 'PAYLOAD_TOO_LARGE'],
  ])('HttpException %# maps to its contract code', (exception, status, code) => {
    const sent = run(exception);
    expect(sent.status).toBe(status);
    expect(sent.body).toMatchObject({ error: { code } });
  });

  it('an HttpException status without a contract code -> 500 INTERNAL_ERROR, and is logged', () => {
    const sent = run(new ForbiddenException('role missing'));
    expect(sent.status).toBe(500);
    expect(sent.body).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(JSON.stringify(sent.body)).not.toContain('role missing');
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it('Fastify body-too-large -> 413 PAYLOAD_TOO_LARGE', () => {
    const sent = run(fastifyError(413, 'FST_ERR_CTP_BODY_TOO_LARGE'));
    expect(sent.status).toBe(413);
    expect(sent.body).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
  });

  it('Fastify malformed JSON / empty body -> 400 VALIDATION_ERROR', () => {
    for (const code of ['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY']) {
      const sent = run(fastifyError(400, code));
      expect(sent.status).toBe(400);
      expect(sent.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
  });

  it('Fastify unsupported media type (415) -> 400 VALIDATION_ERROR', () => {
    const sent = run(fastifyError(415, 'FST_ERR_CTP_INVALID_MEDIA_TYPE'));
    expect(sent.status).toBe(400);
    expect(sent.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('unknown error -> 500 INTERNAL_ERROR with no stack, message or driver text', () => {
    const sent = run(new Error('connect ECONNREFUSED postgres://ggpin:hunter2@db:5432'));
    expect(sent).toEqual({
      status: 500,
      body: {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'errors.INTERNAL_ERROR' },
      },
    });
    const wire = JSON.stringify(sent.body);
    expect(wire).not.toContain('hunter2');
    expect(wire).not.toContain('ECONNREFUSED');
    expect(wire).not.toContain('at ');
  });

  it('logs only method + route pattern for a 500 (no body, headers or raw URL)', () => {
    run(new Error('boom'));
    expect(errorLog).toHaveBeenCalledTimes(1);
    const [message] = errorLog.mock.calls[0] as [string];
    expect(message).toContain('POST /api/v1/things');
  });

  it('non-Error throwables are still a clean 500', () => {
    const sent = run('a string');
    expect(sent.status).toBe(500);
    expect(sent.body).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });
});
