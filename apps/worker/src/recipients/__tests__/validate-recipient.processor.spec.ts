import { UnrecoverableError } from 'bullmq';
import { FOUND, PRODUCT_ID, TIMING, build, job, request, type Setup } from './processor-harness';
import { TG_USERNAME_FORM, stubAdapter } from './recipient-test-doubles';

// The processor and its lookup with the database and the router's routes faked (no Redis, no
// Postgres). The e2e suites run the same code inside a real BullMQ Worker.

describe('ValidateRecipientProcessor', () => {
  it('FOUND: the adapter gets the input normalized again (no @, lower case)', async () => {
    const validate = jest.fn(() => Promise.resolve(FOUND));
    const { processor, logs } = build({ adapters: [stubAdapter('FRAGMENT', { validate })] });
    await expect(processor.process(job(request()))).resolves.toEqual(FOUND);
    expect(validate).toHaveBeenCalledWith(
      { id: PRODUCT_ID, slug: 'stars' },
      { username: 'aziz_k' },
    );
    expect(logs.join('\n')).toMatch(/FOUND \(ANSWERED\) adapter=FRAGMENT \d+ ms/);
  });

  it('an invalid payload is not retried (UnrecoverableError) and its values are not logged', async () => {
    const { processor, logs, find } = build();
    const bad = { productId: PRODUCT_ID, input: { username: 'secret_name_1' }, extra: 'x' };
    await expect(processor.process(job(bad))).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(processor.process(job({ productId: 'secret_name_2' }))).rejects.toThrow(
      'invalid validate-recipient request',
    );
    expect(find).not.toHaveBeenCalled();
    expect(logs.join('\n')).not.toMatch(/secret_name|cmprod/);
  });

  it('an input that does not fit the product form is not retried either', async () => {
    const { processor, logs } = build();
    const wrongKey = { productId: PRODUCT_ID, input: { playerId: 'secret_name_3' } };
    await expect(processor.process(job(wrongKey))).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(processor.process(job(request('1bad')))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(logs.join('\n')).toContain('unrecognized_keys');
    expect(logs.join('\n')).not.toMatch(/secret_name|1bad|playerId/);
  });

  it('a stale job (the API stopped waiting) never reaches the provider', async () => {
    const validate = jest.fn(() => Promise.resolve(FOUND));
    const { processor, find, logs } = build({ adapters: [stubAdapter('FRAGMENT', { validate })] });
    const old = Date.now() - TIMING.waitMs + TIMING.replyMarginMs + TIMING.minCallMs - 5;
    await expect(processor.process(job(request(), old))).resolves.toEqual({
      status: 'UNAVAILABLE',
    });
    expect(find).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('STALE');
  });

  it.each([
    ['no product', { product: null }, 'NO_PRODUCT'],
    [
      'an inactive product',
      { product: { id: PRODUCT_ID, slug: 's', isActive: false, inputSchema: TG_USERNAME_FORM } },
      'INACTIVE',
    ],
    [
      'a broken product form',
      { product: { id: PRODUCT_ID, slug: 's', isActive: true, inputSchema: [{ key: 1 }] } },
      'BAD_PRODUCT_INPUT',
    ],
    ['no route', { routes: [] }, 'NO_ADAPTER'],
    [
      'an unhealthy adapter',
      { adapters: [stubAdapter('FRAGMENT', { health: () => Promise.resolve('DOWN' as const) })] },
      'NO_ADAPTER',
    ],
    ['a route to an unknown adapter', { routes: ['NOPE'] }, 'NO_ADAPTER'],
  ] satisfies [string, Setup, string][])(
    '%s -> UNAVAILABLE, never NOT_FOUND',
    async (_, setup, reason) => {
      const { processor, logs } = build(setup);
      await expect(processor.process(job(request()))).resolves.toEqual({ status: 'UNAVAILABLE' });
      expect(logs.join('\n')).toContain(`UNAVAILABLE (${reason})`);
    },
  );

  it('an adapter throw -> UNAVAILABLE, no throw (no retry), message not logged', async () => {
    const validate = () => Promise.reject(new TypeError('user @aziz_k is broken'));
    const { processor, logs } = build({ adapters: [stubAdapter('FRAGMENT', { validate })] });
    await expect(processor.process(job(request()))).resolves.toEqual({ status: 'UNAVAILABLE' });
    expect(logs.join('\n')).toContain('UNAVAILABLE (ERROR TypeError) adapter=FRAGMENT');
    expect(logs.join('\n')).not.toContain('aziz');
  });

  it('a malformed answer (name too long, unknown status, extra key) -> UNAVAILABLE', async () => {
    const answers = [
      { status: 'FOUND', providerRef: 'r', displayName: 'n'.repeat(129) },
      { status: 'FOUND', providerRef: ' ', displayName: 'Name' },
      { status: 'MAYBE' },
      { status: 'NOT_FOUND', displayName: 'Leaked Name' },
    ];
    for (const answer of answers) {
      const validate = () => Promise.resolve(answer);
      const { processor, logs } = build({ adapters: [stubAdapter('FRAGMENT', { validate })] });
      await expect(processor.process(job(request()))).resolves.toEqual({ status: 'UNAVAILABLE' });
      expect(logs.join('\n')).toContain('UNAVAILABLE (BAD_ANSWER)');
      expect(logs.join('\n')).not.toContain('Leaked');
    }
  });

  it('a hanging adapter is cut at the deadline (timestamp + wait - margin)', async () => {
    const validate = () => new Promise<never>(() => undefined);
    const { processor, logs } = build({ adapters: [stubAdapter('FRAGMENT', { validate })] });
    const timestamp = Date.now();
    await expect(processor.process(job(request(), timestamp))).resolves.toEqual({
      status: 'UNAVAILABLE',
    });
    const ended = Date.now() - timestamp;
    expect(ended).toBeGreaterThanOrEqual(TIMING.waitMs - TIMING.replyMarginMs - 20);
    expect(ended).toBeLessThan(TIMING.waitMs);
    expect(logs.join('\n')).toContain('UNAVAILABLE (TIMEOUT) adapter=FRAGMENT');
  });

  it('a hanging database is cut at the deadline too', async () => {
    const { processor, find } = build();
    find.mockImplementation(() => new Promise<never>(() => undefined));
    await expect(processor.process(job(request()))).resolves.toEqual({ status: 'UNAVAILABLE' });
  });

  it('a database error -> UNAVAILABLE with the class name only', async () => {
    const { processor, find, logs } = build();
    find.mockRejectedValue(new RangeError('row for aziz_k'));
    await expect(processor.process(job(request()))).resolves.toEqual({ status: 'UNAVAILABLE' });
    expect(logs.join('\n')).toContain('(ERROR RangeError) adapter=-');
    expect(logs.join('\n')).not.toContain('aziz');
  });
});
