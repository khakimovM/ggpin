import { randomBytes } from 'node:crypto';
import type { WorkerConfig } from '../../../config/config.module';
import { FragmentSessionKey } from '../../../config/fragment-session-env';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import { SimulatorRefusedError } from '../../simulator/simulator-guard';
import {
  SYNTHETIC_LOGGED_IN_PAGE,
  SYNTHETIC_LOGGED_OUT_PAGE,
  SYNTHETIC_PAGE_HASH,
  SYNTHETIC_UNKNOWN_PAGE,
} from '../../simulator/synthetic-fragment-pages';
import { buildFragmentProbe } from '../fragment-factories';
import { FragmentHttp, type FragmentFetch } from '../fragment-http';
import { fragmentPageState } from '../fragment-login-state';
import {
  FragmentPageScript,
  LiveFragmentProbe,
  SimulatedFragmentProbe,
  type ProbedSession,
} from '../fragment-probe';
import { FragmentSessionStore, sealJar } from '../fragment-session.store';

// One keep-alive look (phase 5 S7) on SYNTHETIC pages: the login state, the Set-Cookie refresh
// stored encrypted, and the fixed failure codes. Fetch is always a fake.

const KEY = randomBytes(32);
const JAR = { cookies: new Map([['stel_ssid', 'sess-one']]), pageHash: null };

function setup(answer: () => Promise<Response>, key: FragmentSessionKey | null = holder()) {
  const updateMany = jest.fn((_args: unknown) => Promise.resolve({ count: 1 }));
  const prisma = { client: { fragmentSession: { updateMany } } } as unknown as PrismaService;
  const store = new FragmentSessionStore(prisma, key ?? undefined);
  const fetches: RequestInit[] = [];
  const fetch: FragmentFetch = (_url, init) => {
    fetches.push(init);
    return answer();
  };
  const probe = new LiveFragmentProbe(store, new FragmentHttp({ fetch, timeoutMs: 100 }));
  const session: ProbedSession = { id: 's1', status: 'ACTIVE', cookiesEnc: sealJar(JAR, KEY) };
  return { probe, store, updateMany, fetches, session };
}

function holder(): FragmentSessionKey {
  return new FragmentSessionKey(KEY.toString('base64'));
}

const respond =
  (body: string, status = 200, setCookies: string[] = []) =>
  () => {
    const headers = new Headers();
    for (const line of setCookies) headers.append('set-cookie', line);
    return Promise.resolve(new Response(body, { status, headers }));
  };

describe('fragmentPageState (synthetic pages)', () => {
  it('logged in with the API hash; logged out; neither is BAD_PAGE', () => {
    expect(fragmentPageState(SYNTHETIC_LOGGED_IN_PAGE)).toEqual({
      state: 'LOGGED_IN',
      apiHash: SYNTHETIC_PAGE_HASH,
    });
    expect(fragmentPageState(SYNTHETIC_LOGGED_OUT_PAGE)).toEqual({ state: 'LOGGED_OUT' });
    expect(fragmentPageState(SYNTHETIC_UNKNOWN_PAGE)).toEqual({ state: 'BAD_PAGE' });
  });

  it('fail-closed: logged-in markers without a hash, or both states at once, are BAD_PAGE', () => {
    const noHash = SYNTHETIC_LOGGED_IN_PAGE.replace(/ajInit[^<]*/, '');
    expect(fragmentPageState(noHash)).toEqual({ state: 'BAD_PAGE' });
    const both = SYNTHETIC_LOGGED_IN_PAGE + SYNTHETIC_LOGGED_OUT_PAGE;
    expect(fragmentPageState(both)).toEqual({ state: 'BAD_PAGE' });
  });
});

describe('LiveFragmentProbe', () => {
  it('a logged-in page: OK; the jar (rotated cookie + page hash) is stored again, sealed', async () => {
    const { probe, store, updateMany, fetches, session } = setup(
      respond(SYNTHETIC_LOGGED_IN_PAGE, 200, ['stel_ssid=sess-two; Path=/; HttpOnly']),
    );
    await expect(probe.check(session)).resolves.toEqual({ kind: 'OK' });
    expect((fetches[0]?.headers as Record<string, string>)['cookie']).toBe('stel_ssid=sess-one');
    expect(updateMany).toHaveBeenCalledTimes(1);
    const args = updateMany.mock.calls[0]?.[0] as {
      where: unknown;
      data: { cookiesEnc: string };
    };
    // The compare-and-set: the row as read, its blob included (S7 audit N-1).
    expect(args.where).toEqual({ id: 's1', status: 'ACTIVE', cookiesEnc: session.cookiesEnc });
    expect(args.data.cookiesEnc).not.toContain('sess-two');
    expect(store.open(args.data.cookiesEnc)).toEqual({
      cookies: new Map([['stel_ssid', 'sess-two']]),
      pageHash: SYNTHETIC_PAGE_HASH,
    });
  });

  it('nothing changed (same hash, no Set-Cookie): nothing is written', async () => {
    const { probe, updateMany } = setup(respond(SYNTHETIC_LOGGED_IN_PAGE));
    const session: ProbedSession = {
      id: 's1',
      status: 'DEAD',
      cookiesEnc: sealJar({ ...JAR, pageHash: SYNTHETIC_PAGE_HASH }, KEY),
    };
    await expect(probe.check(session)).resolves.toEqual({ kind: 'OK' });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('a logged-out page fails LOGGED_OUT, but its Set-Cookie is still kept', async () => {
    const { probe, updateMany, session } = setup(
      respond(SYNTHETIC_LOGGED_OUT_PAGE, 200, ['stel_ssid=sess-three']),
    );
    await expect(probe.check(session)).resolves.toEqual({ kind: 'FAIL', code: 'LOGGED_OUT' });
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an unknown page', respond(SYNTHETIC_UNKNOWN_PAGE), 'BAD_PAGE'],
    ['a 500', respond(SYNTHETIC_LOGGED_IN_PAGE, 500), 'HTTP_STATUS'],
    ['a redirect', respond('', 302), 'REDIRECT'],
    ['a hang', () => new Promise<Response>(() => undefined), 'TIMEOUT'],
    ['a network error', () => Promise.reject(new TypeError('boom')), 'NETWORK'],
  ])('%s: FAIL with a fixed code', async (_what, answer, code) => {
    const { probe, session } = setup(answer);
    await expect(probe.check(session)).resolves.toEqual({ kind: 'FAIL', code });
  });

  it('no key: NO_KEY, no fetch; a blob of another key: BAD_BLOB, no fetch', async () => {
    const noKey = setup(respond(SYNTHETIC_LOGGED_IN_PAGE), null);
    await expect(noKey.probe.check(noKey.session)).resolves.toEqual({
      kind: 'FAIL',
      code: 'NO_KEY',
    });
    expect(noKey.fetches).toHaveLength(0);
    const other = setup(respond(SYNTHETIC_LOGGED_IN_PAGE));
    const foreign = { ...other.session, cookiesEnc: sealJar(JAR, randomBytes(32)) };
    await expect(other.probe.check(foreign)).resolves.toEqual({ kind: 'FAIL', code: 'BAD_BLOB' });
    expect(other.fetches).toHaveLength(0);
  });
});

describe('the dry-run probe and the factory (plan §8)', () => {
  const store = {} as FragmentSessionStore;
  const config = (over: Partial<WorkerConfig>) =>
    ({ NODE_ENV: 'test', FULFILLMENT_DRY_RUN: true, ...over }) as WorkerConfig;

  it('the simulated probe follows its page script and never opens a blob', async () => {
    const script = new FragmentPageScript();
    const probe = new SimulatedFragmentProbe(
      { NODE_ENV: 'test', FULFILLMENT_DRY_RUN: true },
      script,
    );
    const session = { id: 's1', status: 'ACTIVE' as const, cookiesEnc: 'not-a-blob' };
    await expect(probe.check()).resolves.toEqual({ kind: 'OK' });
    script.set('LOGGED_OUT');
    await expect(probe.check()).resolves.toEqual({ kind: 'FAIL', code: 'LOGGED_OUT' });
    script.set('UNKNOWN');
    await expect(probe.check()).resolves.toEqual({ kind: 'FAIL', code: 'BAD_PAGE' });
    script.set('TIMEOUT');
    await expect(probe.check()).resolves.toEqual({ kind: 'FAIL', code: 'TIMEOUT' });
    expect(session.cookiesEnc).toBe('not-a-blob');
    expect(
      () =>
        new SimulatedFragmentProbe({ NODE_ENV: 'production', FULFILLMENT_DRY_RUN: true }, script),
    ).toThrow(SimulatorRefusedError);
  });

  it('dry run: the simulated probe, and the live fetch is never handed out', () => {
    const liveFetch = jest.fn<Promise<Response>, [string, RequestInit]>();
    const probe = buildFragmentProbe(config({}), store, new FragmentPageScript(), liveFetch);
    expect(probe).toBeInstanceOf(SimulatedFragmentProbe);
    expect(
      buildFragmentProbe(
        config({ NODE_ENV: 'production' }),
        store,
        new FragmentPageScript(),
        liveFetch,
      ),
    ).toBeNull();
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it('DRY_RUN=false: the live probe over the given fetch', async () => {
    const liveFetch = jest.fn(respond(SYNTHETIC_LOGGED_IN_PAGE));
    const probe = buildFragmentProbe(
      config({ FULFILLMENT_DRY_RUN: false }),
      new FragmentSessionStore({ client: {} } as unknown as PrismaService, holder()),
      new FragmentPageScript(),
      liveFetch,
    );
    expect(probe).toBeInstanceOf(LiveFragmentProbe);
    const jar = { cookies: new Map([['stel_ssid', 'sess-one']]), pageHash: SYNTHETIC_PAGE_HASH };
    await expect(
      probe?.check({ id: 's1', status: 'ACTIVE', cookiesEnc: sealJar(jar, KEY) }),
    ).resolves.toEqual({ kind: 'OK' });
    expect(liveFetch).toHaveBeenCalledWith('https://fragment.com/', expect.anything());
  });
});
