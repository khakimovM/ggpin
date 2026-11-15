import { AesGcmError } from '../../crypto/aes-gcm';
import { assertSimulatorAllowed, type SimulatorEnv } from '../simulator/simulator-guard';
import {
  SYNTHETIC_LOGGED_IN_PAGE,
  SYNTHETIC_LOGGED_OUT_PAGE,
  SYNTHETIC_UNKNOWN_PAGE,
} from '../simulator/synthetic-fragment-pages';
import { applySetCookies, cookieHeader, type FragmentJar } from './fragment-cookie-jar';
import { FragmentHttp, FragmentHttpError, type FragmentResponse } from './fragment-http';
import { fragmentPageState } from './fragment-login-state';
import {
  FragmentJarFormatError,
  FragmentSessionKeyMissingError,
  type FragmentSessionStore,
} from './fragment-session.store';

// One keep-alive look at a session (phase 5 S7): fetch the page with the session's cookies, store
// the jar again when Set-Cookie changed it, and say whether the page is logged in. Two kinds:
//
// | FULFILLMENT_DRY_RUN | probe                                                          |
// | false               | LiveFragmentProbe: the session's cookies, FragmentHttp, Node fetch |
// | true (not prod)     | SimulatedFragmentProbe: a synthetic page, no cookie is opened  |
// | true + production   | none: the keep-alive does nothing ('disabled')                 |
//
// A failure is a fixed code (FragmentSession.lastError, logs): never a cookie, a hash or a body.

export type KeepaliveFailure =
  | 'LOGGED_OUT'
  | 'BAD_PAGE'
  | 'HTTP_STATUS'
  | 'NO_KEY'
  | 'BAD_BLOB'
  | 'ERROR'
  | FragmentHttpError['code'];

export type ProbeOutcome =
  { readonly kind: 'OK' } | { readonly kind: 'FAIL'; readonly code: KeepaliveFailure };

export interface ProbedSession {
  readonly id: string;
  readonly status: 'ACTIVE' | 'DEAD';
  readonly cookiesEnc: string;
}

export interface FragmentProbe {
  check(session: ProbedSession): Promise<ProbeOutcome>;
}

/** The page the keep-alive loads. */
export const KEEPALIVE_PATH = '/';

const fail = (code: KeepaliveFailure): ProbeOutcome => ({ kind: 'FAIL', code });

function outcomeOfPage(status: number, body: string): ProbeOutcome {
  if (status !== 200) return fail('HTTP_STATUS');
  const page = fragmentPageState(body);
  if (page.state === 'LOGGED_IN') return { kind: 'OK' };
  return fail(page.state);
}

export class LiveFragmentProbe implements FragmentProbe {
  constructor(
    private readonly store: FragmentSessionStore,
    private readonly http: FragmentHttp,
  ) {}

  async check(session: ProbedSession): Promise<ProbeOutcome> {
    let jar: FragmentJar;
    try {
      jar = this.store.open(session.cookiesEnc);
    } catch (error) {
      if (error instanceof FragmentSessionKeyMissingError) return fail('NO_KEY');
      if (error instanceof AesGcmError || error instanceof FragmentJarFormatError) {
        return fail('BAD_BLOB');
      }
      throw error;
    }
    let response: FragmentResponse;
    try {
      response = await this.http.request({
        method: 'GET',
        path: KEEPALIVE_PATH,
        cookieHeader: cookieHeader(jar),
      });
    } catch (error) {
      if (error instanceof FragmentHttpError) return fail(error.code);
      throw error;
    }
    // Every Set-Cookie is kept (docs/06), whatever the page says: Fragment rotates stel_* values.
    let { jar: next, changed } = applySetCookies(jar, response.setCookies);
    const page = response.status === 200 ? fragmentPageState(response.body) : null;
    if (page?.state === 'LOGGED_IN' && page.apiHash !== next.pageHash) {
      next = { cookies: next.cookies, pageHash: page.apiHash };
      changed = true;
    }
    if (changed) await this.store.save(session, next);
    return outcomeOfPage(response.status, response.body);
  }
}

export type SyntheticPage = 'LOGGED_IN' | 'LOGGED_OUT' | 'UNKNOWN' | 'TIMEOUT';

/** What the dry-run Fragment page looks like (dev: always logged in; tests script it). */
export class FragmentPageScript {
  private page: SyntheticPage = 'LOGGED_IN';

  set(page: SyntheticPage): void {
    this.page = page;
  }

  current(): SyntheticPage {
    return this.page;
  }
}

const SYNTHETIC: Readonly<Record<Exclude<SyntheticPage, 'TIMEOUT'>, string>> = {
  LOGGED_IN: SYNTHETIC_LOGGED_IN_PAGE,
  LOGGED_OUT: SYNTHETIC_LOGGED_OUT_PAGE,
  UNKNOWN: SYNTHETIC_UNKNOWN_PAGE,
};

/**
 * The dry-run keep-alive (plan §8): never reaches fragment.com and never opens the session blob
 * (no Fragment cookie is read while nothing can be sent). It runs the same page check on a
 * synthetic page. Refuses production and DRY_RUN=false like every simulator.
 */
export class SimulatedFragmentProbe implements FragmentProbe {
  constructor(
    env: SimulatorEnv,
    private readonly script: FragmentPageScript,
  ) {
    assertSimulatorAllowed(env);
  }

  check(): Promise<ProbeOutcome> {
    const page = this.script.current();
    if (page === 'TIMEOUT') return Promise.resolve(fail('TIMEOUT'));
    return Promise.resolve(outcomeOfPage(200, SYNTHETIC[page]));
  }
}
