import { ADAPTER_CALL_TIMEOUT_MS } from '../../fulfillment-adapter';
import { FragmentHttp, FragmentHttpError, type FragmentFetch } from '../fragment-http';

// The one HTTP door to fragment.com (phase 5 S7). Every fetch here is a fake: no network.

const COOKIE = 'stel_ssid=sess-one';

function recorder(answer: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FragmentFetch = (url, init) => {
    calls.push({ url, init });
    return answer();
  };
  return { fetch, calls };
}

const page =
  (body: string, init: ResponseInit = {}) =>
  () =>
    Promise.resolve(new Response(body, { status: 200, ...init }));

/** A body that sends one chunk and then never ends. */
function endlessBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('<html>'));
    },
  });
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof FragmentHttpError) {
      // A fixed message: never the path, the cookie or the body.
      expect(error.message).toBe(`fragment.com request failed: ${error.code}`);
      return error.code;
    }
    throw error;
  }
  return 'RESOLVED';
}

describe('FragmentHttp', () => {
  it('GET on fragment.com: cookie header, manual redirects, a signal, Set-Cookie lines back', async () => {
    const headers = new Headers();
    headers.append('set-cookie', 'stel_ssid=sess-two; Path=/; HttpOnly');
    headers.append('set-cookie', 'stel_dt=-300; Path=/');
    const { fetch, calls } = recorder(page('<html>ok</html>', { headers }));
    const http = new FragmentHttp({ fetch });
    await expect(http.request({ method: 'GET', path: '/', cookieHeader: COOKIE })).resolves.toEqual(
      {
        status: 200,
        setCookies: ['stel_ssid=sess-two; Path=/; HttpOnly', 'stel_dt=-300; Path=/'],
        body: '<html>ok</html>',
      },
    );
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://fragment.com/');
    expect(call?.init.redirect).toBe('manual');
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    const sent = call?.init.headers as Record<string, string>;
    expect(sent['cookie']).toBe(COOKIE);
    expect(sent['user-agent']).not.toMatch(/ggpin/i);
  });

  it('POST sends the form urlencoded; an empty jar sends no cookie header', async () => {
    const { fetch, calls } = recorder(page('{}'));
    await new FragmentHttp({ fetch }).request({
      method: 'POST',
      path: '/api?hash=abc123',
      cookieHeader: '',
      form: { query: 'a b', method: 'searchStarsRecipient' },
    });
    expect(calls[0]?.url).toBe('https://fragment.com/api?hash=abc123');
    expect(calls[0]?.init.body).toBe('query=a+b&method=searchStarsRecipient');
    const sent = calls[0]?.init.headers as Record<string, string>;
    expect(sent['cookie']).toBeUndefined();
    expect(sent['content-type']).toMatch(/^application\/x-www-form-urlencoded/);
  });

  it.each([
    'https://evil.test/',
    '//evil.test/',
    'https://fragment.com.evil.test/',
    'https://evil.test@fragment.com/',
    'https://fragment.com:8443/',
    'http://fragment.com/',
    'https://sub.fragment.com/',
  ])('host allowlist: %s is refused before any fetch (FOREIGN_HOST)', async (path) => {
    const { fetch, calls } = recorder(page('x'));
    const http = new FragmentHttp({ fetch });
    await expect(codeOf(http.request({ method: 'GET', path, cookieHeader: COOKIE }))).resolves.toBe(
      'FOREIGN_HOST',
    );
    expect(calls).toHaveLength(0);
  });

  it.each([301, 302, 303, 307, 308])('a %s is never followed (REDIRECT)', async (status) => {
    const { fetch, calls } = recorder(() =>
      Promise.resolve(new Response(null, { status, headers: { location: 'https://evil.test/' } })),
    );
    const http = new FragmentHttp({ fetch });
    await expect(
      codeOf(http.request({ method: 'GET', path: '/', cookieHeader: COOKIE })),
    ).resolves.toBe('REDIRECT');
    expect(calls).toHaveLength(1);
  });

  it('a fetch that never answers ends at the timeout (TIMEOUT)', async () => {
    const { fetch } = recorder(() => new Promise<Response>(() => undefined));
    const http = new FragmentHttp({ fetch, timeoutMs: 50 });
    await expect(
      codeOf(http.request({ method: 'GET', path: '/', cookieHeader: COOKIE })),
    ).resolves.toBe('TIMEOUT');
  });

  it('a body that never ends ends at the timeout too (TIMEOUT)', async () => {
    const { fetch } = recorder(() => Promise.resolve(new Response(endlessBody(), { status: 200 })));
    const http = new FragmentHttp({ fetch, timeoutMs: 50 });
    const started = Date.now();
    await expect(
      codeOf(http.request({ method: 'GET', path: '/', cookieHeader: COOKIE })),
    ).resolves.toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('the caller aborting ends the request (ABORTED), and its signal reaches fetch', async () => {
    let seen: AbortSignal | null | undefined;
    const fetch: FragmentFetch = (_url, init) => {
      seen = init.signal;
      return new Promise<Response>(() => undefined);
    };
    const controller = new AbortController();
    const work = new FragmentHttp({ fetch }).request({
      method: 'GET',
      path: '/',
      cookieHeader: COOKIE,
      signal: controller.signal,
    });
    controller.abort();
    await expect(codeOf(work)).resolves.toBe('ABORTED');
    expect(seen?.aborted).toBe(true);
  });

  it('a fetch that throws is NETWORK, with nothing of the cause in the message', async () => {
    const { fetch } = recorder(() => Promise.reject(new TypeError(`connect failed ${COOKIE}`)));
    await expect(
      codeOf(
        new FragmentHttp({ fetch }).request({ method: 'GET', path: '/', cookieHeader: COOKIE }),
      ),
    ).resolves.toBe('NETWORK');
  });

  it('a declared length over the limit is refused unread (TOO_LARGE)', async () => {
    const { fetch } = recorder(page('small', { headers: { 'content-length': '101' } }));
    const http = new FragmentHttp({ fetch, maxBodyBytes: 100 });
    await expect(
      codeOf(http.request({ method: 'GET', path: '/', cookieHeader: COOKIE })),
    ).resolves.toBe('TOO_LARGE');
  });

  it('a streamed body past the limit is cut (TOO_LARGE); exactly the limit is read', async () => {
    const big = new FragmentHttp({
      fetch: recorder(page('x'.repeat(101))).fetch,
      maxBodyBytes: 100,
    });
    await expect(
      codeOf(big.request({ method: 'GET', path: '/', cookieHeader: COOKIE })),
    ).resolves.toBe('TOO_LARGE');
    const edge = new FragmentHttp({
      fetch: recorder(page('x'.repeat(100))).fetch,
      maxBodyBytes: 100,
    });
    await expect(
      edge.request({ method: 'GET', path: '/', cookieHeader: COOKIE }),
    ).resolves.toMatchObject({ body: 'x'.repeat(100) });
  });

  it('a timeout option longer than an adapter call may take is capped (I-1)', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    try {
      const { fetch } = recorder(page('ok'));
      await new FragmentHttp({ fetch, timeoutMs: 60_000 }).request({
        method: 'GET',
        path: '/',
        cookieHeader: COOKIE,
      });
      expect(timeout).toHaveBeenCalledWith(ADAPTER_CALL_TIMEOUT_MS);
    } finally {
      timeout.mockRestore();
    }
  });
});
