import type { WorkerConfig } from '../../config/config.module';
import { FragmentHttp, type FragmentFetch } from './fragment-http';
import {
  LiveFragmentProbe,
  SimulatedFragmentProbe,
  type FragmentPageScript,
  type FragmentProbe,
} from './fragment-probe';
import type { FragmentSessionStore } from './fragment-session.store';

// Which keep-alive probe exists is decided here and only here (plan §8):
//
// | FULFILLMENT_DRY_RUN | NODE_ENV   | probe                                             |
// | true                | dev / test | SimulatedFragmentProbe (synthetic page, no cookie) |
// | true                | production | none: the keep-alive does nothing                 |
// | false               | any        | LiveFragmentProbe over Node's fetch (fragment.com) |
//
// Node's fetch is handed to FragmentHttp ONLY on the live branch: a dry-run worker holds no
// function that could reach fragment.com.

/** The page script of the dry-run probe (dev: logged in; tests script it). */
export const FRAGMENT_PAGE_SCRIPT = Symbol('FRAGMENT_PAGE_SCRIPT');

const nodeFetch: FragmentFetch = (input, init) => fetch(input, init);

export function buildFragmentProbe(
  config: Pick<WorkerConfig, 'FULFILLMENT_DRY_RUN' | 'NODE_ENV'>,
  store: FragmentSessionStore,
  script: FragmentPageScript,
  liveFetch: FragmentFetch = nodeFetch,
): FragmentProbe | null {
  if (!config.FULFILLMENT_DRY_RUN) {
    return new LiveFragmentProbe(store, new FragmentHttp({ fetch: liveFetch }));
  }
  if (config.NODE_ENV === 'production') return null;
  return new SimulatedFragmentProbe(config, script);
}
