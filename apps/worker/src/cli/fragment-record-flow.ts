import {
  ForeignHostError,
  detectPageMarkers,
  extractAccountNames,
  extractApiHash,
  type PageMarkers,
} from '../adapters/fragment/fragment-page';
import type { SecretValue } from '../adapters/fragment/fixture-sanitizer';
import type { TonConnectInfo } from './fragment-record-inputs';
import {
  FragmentRecorderClient,
  RecorderCookieJar,
  type Exchange,
  type FetchLike,
} from './fragment-record-client';
import { linkFields, takeLink } from './fragment-record-link';
import { foundSecrets, runPremiumSteps } from './fragment-record-premium';
import { readFound, readReqId, type PayloadInfo } from './fragment-record-read';

// The recording steps (plan S0b, P6-S0a). Every step is money-free: a page, a recipient search, a
// purchase request, the payment link description. Nothing is signed or sent; the tool has no
// such code. Each raw exchange is handed to `onExchange` at once (written outside the repo).

export const STARS_QUANTITY = '50';
export const RECIPIENT_AGE_WAIT_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 20_000;

export type StepName =
  | 'page-logged-in'
  | 'search-stars-recipient'
  | 'init-buy-stars'
  | 'get-buy-stars-link'
  | 'page-premium-gift'
  | 'search-premium-recipient'
  | 'search-premium-holder'
  | 'init-gift-premium'
  | 'get-gift-premium-link'
  | 'page-logged-out'
  | 'init-buy-stars-after-10min';

export interface RecordedStep {
  readonly step: StepName;
  readonly exchange: Exchange;
}

export interface FlowInput {
  readonly cookies: ReadonlyMap<string, string>;
  readonly username: string;
  readonly confirmNoPayment: boolean;
  readonly recipientAgeCheck: boolean;
  readonly tonConnect: TonConnectInfo | null;
  /** An account that already has Premium (Q10), searched only when given. */
  readonly premiumHolder: string | null;
}

export interface FlowDeps {
  readonly fetch: FetchLike;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onExchange: (recorded: RecordedStep) => Promise<void>;
  readonly note: (line: string) => void;
}

export interface PerProduct<T> {
  readonly stars: T[];
  readonly premium: T[];
}

export interface FlowResult {
  readonly steps: RecordedStep[];
  readonly secrets: SecretValue[];
  /** What only the premium holder's search can show (its username, name, photo, recipient). */
  readonly holderSecrets: SecretValue[];
  /** Every pay address kept by the sanitizer (Stars and Premium). */
  readonly keepAddresses: string[];
  readonly payAddresses: PerProduct<string>;
  readonly markers: {
    loggedIn: PageMarkers | null;
    premiumGift: PageMarkers | null;
    loggedOut: PageMarkers | null;
  };
  apiHashLength: number | null;
  /** Null when the Premium page was not reached. */
  premiumApiHash: { found: boolean; sameAsStars: boolean | null } | null;
  readonly skipped: StepName[];
  stoppedBy: string | null;
  readonly cookieNames: string[];
  readonly setCookieNames: string[];
  readonly linkPayloads: PerProduct<PayloadInfo>;
}

function cookieValue(line: string): string {
  const pair = line.split(';')[0] ?? '';
  return pair.slice(pair.indexOf('=') + 1).trim();
}

/** Why the run stopped, without echoing anything a response or an input carried. */
function stopReason(error: unknown): string {
  if (error instanceof ForeignHostError) return error.message;
  return `request failed (${error instanceof Error ? error.name : 'unknown error'})`;
}

export type RecordFn = (step: StepName, exchange: Exchange) => Promise<Exchange>;

export async function runRecordingFlow(input: FlowInput, deps: FlowDeps): Promise<FlowResult> {
  const secrets: SecretValue[] = [
    ...[...input.cookies.values()].map((value) => ({ kind: 'cookie' as const, value })),
    { kind: 'username', value: input.username },
  ];
  if (input.tonConnect !== null) {
    secrets.push({ kind: 'address', value: input.tonConnect.address });
    for (const value of [input.tonConnect.publicKey, input.tonConnect.walletStateInit]) {
      if (value !== null) secrets.push({ kind: 'wallet', value });
    }
  }
  const holderSecrets: SecretValue[] = [];
  // Known before any request: the holder's username is redacted wherever an answer echoes it.
  if (input.premiumHolder !== null) {
    holderSecrets.push({ kind: 'username', value: input.premiumHolder });
  }
  const result: FlowResult = {
    steps: [],
    secrets,
    holderSecrets,
    keepAddresses: [],
    payAddresses: { stars: [], premium: [] },
    markers: { loggedIn: null, premiumGift: null, loggedOut: null },
    apiHashLength: null,
    premiumApiHash: null,
    skipped: [],
    stoppedBy: null,
    cookieNames: [...input.cookies.keys()].sort(),
    setCookieNames: [],
    linkPayloads: { stars: [], premium: [] },
  };
  const record: RecordFn = async (step, exchange) => {
    for (const line of exchange.response.setCookies) {
      secrets.push({ kind: 'cookie', value: cookieValue(line) });
      const name = (line.split('=')[0] ?? '').trim();
      if (name !== '' && !result.setCookieNames.includes(name)) result.setCookieNames.push(name);
    }
    result.steps.push({ step, exchange });
    await deps.onExchange({ step, exchange });
    return exchange;
  };
  try {
    result.stoppedBy = await runSteps(input, deps, result, record);
  } catch (error) {
    result.stoppedBy = stopReason(error);
  }
  return result;
}

/** The steps in order; returns why it stopped early, or null when every step ran. */
async function runSteps(
  input: FlowInput,
  deps: FlowDeps,
  result: FlowResult,
  record: RecordFn,
): Promise<string | null> {
  const { secrets } = result;
  const client = new FragmentRecorderClient(
    deps.fetch,
    new RecorderCookieJar(input.cookies),
    TIMEOUT_MS,
    input.confirmNoPayment,
  );
  const page = await record('page-logged-in', await client.page());
  const html = page.response.body;
  result.markers.loggedIn = detectPageMarkers(html);
  for (const name of extractAccountNames(html)) secrets.push({ kind: 'name', value: name });
  const hash = extractApiHash(html);
  if (hash === null) return 'no api hash on the page';
  secrets.push({ kind: 'hash', value: hash });
  result.apiHashLength = hash.length;

  const search = await record(
    'search-stars-recipient',
    await client.api(hash, 'searchStarsRecipient', { query: input.username, quantity: '' }),
  );
  const found = readFound(search.response.body);
  secrets.push(...foundSecrets(found));
  const initFields = (recipient: string): Record<string, string> => ({
    recipient,
    quantity: STARS_QUANTITY,
    payment_method: 'ton',
  });

  if (!input.confirmNoPayment) {
    result.skipped.push('init-buy-stars', 'get-buy-stars-link');
    deps.note('init-buy-stars, get-buy-stars-link skipped: --confirm-no-payment not given');
  } else if (found === null) {
    result.skipped.push('init-buy-stars', 'get-buy-stars-link');
    deps.note('init-buy-stars, get-buy-stars-link skipped: no recipient in the search response');
  } else {
    const init = await record(
      'init-buy-stars',
      await client.api(hash, 'initBuyStarsRequest', initFields(found.recipient)),
    );
    const reqId = readReqId(init.response.body);
    if (reqId === null) {
      result.skipped.push('get-buy-stars-link');
      deps.note('get-buy-stars-link skipped: no req_id in the init response');
    } else {
      const link = await record(
        'get-buy-stars-link',
        await client.api(hash, 'getBuyStarsLink', linkFields(reqId, input.tonConnect)),
      );
      const facts = takeLink(link.response.body, secrets);
      result.linkPayloads.stars.push(...facts.payloads);
      if (facts.payTo === null) return 'the link response does not hold exactly one message';
      result.keepAddresses.push(...facts.payTo);
      result.payAddresses.stars.push(...facts.payTo);
    }
  }

  const premiumStop = await runPremiumSteps({ input, deps, result, record, client, hash });
  if (premiumStop !== null) return premiumStop;

  const anonymous = new FragmentRecorderClient(deps.fetch, null, TIMEOUT_MS);
  const loggedOut = await record('page-logged-out', await anonymous.page());
  result.markers.loggedOut = detectPageMarkers(loggedOut.response.body);

  if (input.recipientAgeCheck && input.confirmNoPayment) {
    if (found === null) {
      result.skipped.push('init-buy-stars-after-10min');
    } else {
      deps.note('waiting 10 minutes for the recipient age check');
      await deps.sleep(RECIPIENT_AGE_WAIT_MS);
      await record(
        'init-buy-stars-after-10min',
        await client.api(hash, 'initBuyStarsRequest', initFields(found.recipient)),
      );
    }
  }
  return null;
}
