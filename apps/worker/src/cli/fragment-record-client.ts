import {
  FRAGMENT_HOST,
  FRAGMENT_ORIGIN,
  STARS_PAGE_PATH,
  assertFragmentUrl,
} from '../adapters/fragment/fragment-page';

// The recorder's HTTP side (plan S0b). It talks to https://fragment.com only (every URL and every
// redirect target is checked), calls only the read/prepare methods below, and has no code that
// signs or sends a TON transaction. `fetch` is injected: tests never reach the network.

/** The only API methods the recorder may call. The method that submits a signed BOC is not here. */
export const RECORDER_API_METHODS = [
  'searchStarsRecipient',
  'initBuyStarsRequest',
  'getBuyStarsLink',
] as const;
export type RecorderApiMethod = (typeof RECORDER_API_METHODS)[number];

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface Exchange {
  readonly request: {
    readonly method: 'GET' | 'POST';
    readonly url: string;
    readonly form: Readonly<Record<string, string>> | null;
  };
  readonly response: {
    readonly status: number;
    readonly headers: ReadonlyArray<readonly [string, string]>;
    readonly setCookies: readonly string[];
    readonly body: string;
  };
  /** Same-host redirects followed before this response (statuses and paths). */
  readonly redirects: ReadonlyArray<{ readonly status: number; readonly path: string }>;
}

const MAX_REDIRECTS = 3;
// A generic desktop browser identity: the recorder must not name the project or its owner.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Safari/537.36';

/** Cookies of one session; `Set-Cookie` from fragment.com updates or removes them. */
export class RecorderCookieJar {
  private readonly cookies: Map<string, string>;

  constructor(initial: ReadonlyMap<string, string>) {
    this.cookies = new Map(initial);
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  /** Applies one Set-Cookie line; returns the cookie name (or null when it was ignored). */
  apply(line: string): string | null {
    const [pair = '', ...attributes] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) return null;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    let expired = false;
    for (const attribute of attributes) {
      const [rawKey = '', rawVal = ''] = attribute.split('=');
      const key = rawKey.trim().toLowerCase();
      const val = rawVal.trim().toLowerCase().replace(/^\./, '');
      if (key === 'domain' && val !== FRAGMENT_HOST && !val.endsWith(`.${FRAGMENT_HOST}`)) {
        return null;
      }
      if (key === 'max-age' && Number(val) <= 0) expired = true;
      if (key === 'expires' && Date.parse(rawVal.trim()) < Date.now()) expired = true;
    }
    if (expired || value === '' || value === 'deleted') this.cookies.delete(name);
    else this.cookies.set(name, value);
    return name;
  }

  names(): string[] {
    return [...this.cookies.keys()];
  }
}

export class FragmentRecorderClient {
  constructor(
    private readonly fetchFn: FetchLike,
    private readonly jar: RecorderCookieJar | null,
    private readonly timeoutMs: number,
  ) {}

  /** GET a page; follows up to 3 redirects, each checked to stay on fragment.com. */
  async page(path: string = STARS_PAGE_PATH): Promise<Exchange> {
    const redirects: Array<{ status: number; path: string }> = [];
    const earlierCookies: string[] = [];
    let url = assertFragmentUrl(path);
    for (;;) {
      const response = await this.send(url, {
        method: 'GET',
        headers: this.headers({
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        }),
      });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location !== null) {
        const next = assertFragmentUrl(new URL(location, url));
        if (redirects.length >= MAX_REDIRECTS) {
          return this.exchange(url, 'GET', null, response, redirects, earlierCookies);
        }
        // m1: a redirect's Set-Cookie is part of the session and of the secrets to redact.
        const lines = response.headers.getSetCookie();
        earlierCookies.push(...lines);
        if (this.jar !== null) for (const line of lines) this.jar.apply(line);
        await response.body?.cancel();
        redirects.push({ status: response.status, path: url.pathname });
        url = next;
        continue;
      }
      return this.exchange(url, 'GET', null, response, redirects, earlierCookies);
    }
  }

  /** POST one allowed method to `/api?hash=...`; redirects are never followed. */
  async api(
    hash: string,
    method: RecorderApiMethod,
    fields: Readonly<Record<string, string>>,
  ): Promise<Exchange> {
    if (!(RECORDER_API_METHODS as readonly string[]).includes(method)) {
      throw new Error('refused: method not allowed in the recorder');
    }
    if (!/^[a-fA-F0-9]{6,64}$/.test(hash)) throw new Error('refused: malformed api hash');
    const url = assertFragmentUrl(`/api?hash=${hash}`);
    const form = { ...fields, method };
    const response = await this.send(url, {
      method: 'POST',
      headers: this.headers({
        accept: 'application/json, text/javascript, */*; q=0.01',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        origin: FRAGMENT_ORIGIN,
        referer: `${FRAGMENT_ORIGIN}${STARS_PAGE_PATH}`,
        'x-requested-with': 'XMLHttpRequest',
      }),
      body: new URLSearchParams(form).toString(),
    });
    const location = response.headers.get('location');
    if (location !== null) assertFragmentUrl(new URL(location, url));
    return this.exchange(url, 'POST', form, response, []);
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { 'user-agent': USER_AGENT, ...extra };
    if (this.jar !== null) headers['cookie'] = this.jar.header();
    return headers;
  }

  private async send(url: URL, init: RequestInit): Promise<Response> {
    assertFragmentUrl(url);
    return this.fetchFn(url.toString(), {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private async exchange(
    url: URL,
    method: 'GET' | 'POST',
    form: Readonly<Record<string, string>> | null,
    response: Response,
    redirects: ReadonlyArray<{ status: number; path: string }>,
    earlierCookies: readonly string[] = [],
  ): Promise<Exchange> {
    const own = response.headers.getSetCookie();
    if (this.jar !== null) for (const line of own) this.jar.apply(line);
    const setCookies = [...earlierCookies, ...own];
    return {
      request: { method, url: url.toString(), form },
      response: {
        status: response.status,
        headers: [...response.headers.entries()],
        setCookies,
        body: await response.text(),
      },
      redirects,
    };
  }
}
