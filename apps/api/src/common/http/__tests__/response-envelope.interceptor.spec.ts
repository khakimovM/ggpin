import { StreamableFile, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { RAW_RESPONSE_KEY } from '../raw-response.decorator';
import { ResponseEnvelopeInterceptor } from '../response-envelope.interceptor';
import { paginated, WithMeta } from '../with-meta';

function contextOf(type: string): ExecutionContext {
  const handler = (): void => undefined;
  class Ctl {}
  return {
    getType: () => type,
    getHandler: () => handler,
    getClass: () => Ctl,
  } as unknown as ExecutionContext;
}

async function run(
  result: unknown,
  options: { raw?: boolean; type?: string } = {},
): Promise<unknown> {
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'getAllAndOverride')
    .mockImplementation((key) => (key === RAW_RESPONSE_KEY ? options.raw : undefined));
  const interceptor = new ResponseEnvelopeInterceptor(reflector);
  const next: CallHandler = { handle: () => of(result) };
  return lastValueFrom(interceptor.intercept(contextOf(options.type ?? 'http'), next));
}

describe('ResponseEnvelopeInterceptor', () => {
  it('wraps a plain result as { success, data } without meta', async () => {
    const out = await run({ id: 'a' });
    expect(out).toEqual({ success: true, data: { id: 'a' } });
    expect(out).not.toHaveProperty('meta');
  });

  it('serialises nested BigInt as strings', async () => {
    const out = await run({ items: [{ price: 1_255_000n }], total: 5n });
    expect(out).toEqual({ success: true, data: { items: [{ price: '1255000' }], total: '5' } });
  });

  it('wraps arrays', async () => {
    expect(await run([1n, 2n])).toEqual({ success: true, data: ['1', '2'] });
  });

  it('turns null and undefined into data: null so the key survives JSON', async () => {
    expect(await run(null)).toEqual({ success: true, data: null });
    const out = await run(undefined);
    expect(out).toEqual({ success: true, data: null });
    expect(JSON.parse(JSON.stringify(out))).toHaveProperty('data', null);
  });

  it('passes WithMeta data and meta through (and converts BigInt in both)', async () => {
    const out = await run(new WithMeta([{ n: 1n }], { page: 2, limit: 20, total: 41 }));
    expect(out).toEqual({
      success: true,
      data: [{ n: '1' }],
      meta: { page: 2, limit: 20, total: 41 },
    });
  });

  it('paginated() builds the contract meta { page, limit, total }', async () => {
    const out = await run(paginated(['a'], { page: 1, limit: 20, total: 1 }));
    expect(out).toEqual({ success: true, data: ['a'], meta: { page: 1, limit: 20, total: 1 } });
  });

  it('returns the raw result untouched for @RawResponse() routes', async () => {
    const body = { status: 'ok' };
    expect(await run(body, { raw: true })).toBe(body);
  });

  it('does not envelope binary payloads', async () => {
    const file = new StreamableFile(Buffer.from('x'));
    expect(await run(file)).toBe(file);
    const buffer = Buffer.from('y');
    expect(await run(buffer)).toBe(buffer);
  });

  it('ignores non-http contexts', async () => {
    const body = { a: 1 };
    expect(await run(body, { type: 'rpc' })).toBe(body);
  });
});
