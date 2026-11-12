import type { FetchLike } from '../fragment-record-client';
import {
  FAKE,
  initResponse,
  linkResponse,
  loggedInPage,
  loggedOutPage,
  searchResponse,
} from '../../adapters/fragment/__tests__/fragment-fakes';

// A fake fragment.com for the recorder tests: no socket is ever opened. It records every call
// and answers with the made-up responses of fragment-fakes.ts.

/** A TON Connect DeviceInfo as a wallet would send it (made up). */
export const DEVICE = {
  platform: 'windows',
  appName: 'tonkeeper',
  appVersion: '3.0.0',
  maxProtocolVersion: 2,
  features: ['SendTransaction', { name: 'SendTransaction', maxMessages: 4 }],
};

export interface FakeCall {
  readonly url: string;
  readonly method: string;
  readonly cookie: string | null;
  readonly form: URLSearchParams | null;
  readonly redirect: RequestRedirect | undefined;
}

export interface FakeFragment {
  readonly fetch: FetchLike;
  readonly calls: FakeCall[];
  apiMethods(): string[];
}

export type Override = (call: FakeCall) => Response | null;

const json = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });

export function fakeFragment(override: Override = () => null): FakeFragment {
  const calls: FakeCall[] = [];
  const fetchFn: FetchLike = (input, init) => Promise.resolve(answer(input, init));
  const answer = (input: string, init: RequestInit): Response => {
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : null;
    const call: FakeCall = {
      url: input,
      method: init.method ?? 'GET',
      cookie: headers.get('cookie'),
      form: body === null ? null : new URLSearchParams(body),
      redirect: init.redirect,
    };
    calls.push(call);
    const custom = override(call);
    if (custom !== null) return custom;
    const url = new URL(input);
    if (call.method === 'GET') {
      const html = call.cookie === null ? loggedOutPage() : loggedInPage();
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (url.searchParams.get('hash') !== FAKE.hash) return json({ error: 'Access denied' });
    switch (call.form?.get('method')) {
      case 'searchStarsRecipient':
        return json(searchResponse(), {
          'set-cookie': `stel_ssid=${FAKE.refreshedSsid}; path=/; secure; HttpOnly`,
        });
      case 'initBuyStarsRequest':
        return json(initResponse());
      case 'getBuyStarsLink':
        return json(linkResponse());
      default:
        return json({ error: 'Unknown method' });
    }
  };
  return {
    fetch: fetchFn,
    calls,
    apiMethods: () =>
      calls.filter((c) => c.form !== null).map((c) => c.form?.get('method') ?? '<none>'),
  };
}
