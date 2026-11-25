import {
  detectPageMarkers,
  extractAccountNames,
  extractApiHash,
} from '../adapters/fragment/fragment-page';
import type { SecretValue } from '../adapters/fragment/fixture-sanitizer';
import {
  PREMIUM_GIFT_PAGE_PATH,
  type FragmentRecorderClient,
  type RecorderApiMethod,
} from './fragment-record-client';
import type { FlowDeps, FlowInput, FlowResult, RecordFn, StepName } from './fragment-record-flow';
import { linkFields, takeLink } from './fragment-record-link';
import { readFound, readReqId, type FoundRecipient } from './fragment-record-read';

// The Premium steps of `fragment:record` (P6-S0a), all money-free: the gift page, a recipient
// search for the owner (3 months), an optional search for an account that already has Premium
// (--premium-holder, Q10), and, only with --confirm-no-payment, the gift request and its payment
// link DESCRIPTION. Nothing is signed or sent. `updatePremiumState` is not called: nothing shows
// that it only reads. Field names are guesses (docs/suppliers/fragment.md §6).

/** The package the recorder asks about: the smallest one sold (seed SKU 3/6/12). */
export const PREMIUM_MONTHS = '3';

const API_STEPS: readonly StepName[] = [
  'search-premium-recipient',
  'search-premium-holder',
  'init-gift-premium',
  'get-gift-premium-link',
];

/** The recipient, display name and photo of a search answer, as secrets. */
export function foundSecrets(found: FoundRecipient | null): SecretValue[] {
  if (found === null) return [];
  const out: SecretValue[] = [{ kind: 'recipient', value: found.recipient }];
  if (found.name !== null) out.push({ kind: 'name', value: found.name });
  if (found.photo !== null) out.push({ kind: 'photo', value: found.photo });
  return out;
}

export interface PremiumContext {
  readonly input: FlowInput;
  readonly deps: FlowDeps;
  readonly result: FlowResult;
  readonly record: RecordFn;
  /** The logged-in client of the run (its cookie jar, its purchase gate). */
  readonly client: FragmentRecorderClient;
  /** The API hash of the Stars page. */
  readonly hash: string;
}

/** Runs the Premium steps; returns why the run must stop, or null. */
export async function runPremiumSteps(ctx: PremiumContext): Promise<string | null> {
  const { input, deps, result, record, client } = ctx;
  const page = await record('page-premium-gift', await client.page(PREMIUM_GIFT_PAGE_PATH));
  const html = page.response.body;
  result.markers.premiumGift = detectPageMarkers(html);
  for (const name of extractAccountNames(html)) result.secrets.push({ kind: 'name', value: name });
  const hash = extractApiHash(html);
  result.premiumApiHash = {
    found: hash !== null,
    sameAsStars: hash === null ? null : hash.toLowerCase() === ctx.hash.toLowerCase(),
  };
  if (hash === null) {
    result.skipped.push(...API_STEPS);
    deps.note('premium searches and purchase steps skipped: no api hash on the premium page');
    return null;
  }
  result.secrets.push({ kind: 'hash', value: hash });
  const api = (method: RecorderApiMethod, fields: Record<string, string>) =>
    client.api(hash, method, fields, PREMIUM_GIFT_PAGE_PATH);

  const search = await record(
    'search-premium-recipient',
    await api('searchPremiumGiftRecipient', { query: input.username, months: PREMIUM_MONTHS }),
  );
  const found = readFound(search.response.body);
  result.secrets.push(...foundSecrets(found));

  if (input.premiumHolder === null) {
    result.skipped.push('search-premium-holder');
  } else {
    const holder = await record(
      'search-premium-holder',
      await api('searchPremiumGiftRecipient', {
        query: input.premiumHolder,
        months: PREMIUM_MONTHS,
      }),
    );
    result.holderSecrets.push(...foundSecrets(readFound(holder.response.body)));
  }

  const purchaseSteps = 'init-gift-premium, get-gift-premium-link skipped';
  if (!input.confirmNoPayment) {
    result.skipped.push('init-gift-premium', 'get-gift-premium-link');
    deps.note(`${purchaseSteps}: --confirm-no-payment not given`);
    return null;
  }
  if (found === null) {
    result.skipped.push('init-gift-premium', 'get-gift-premium-link');
    deps.note(`${purchaseSteps}: no recipient in the premium search response`);
    return null;
  }
  const init = await record(
    'init-gift-premium',
    await api('initGiftPremiumRequest', { recipient: found.recipient, months: PREMIUM_MONTHS }),
  );
  const reqId = readReqId(init.response.body);
  if (reqId === null) {
    result.skipped.push('get-gift-premium-link');
    deps.note('get-gift-premium-link skipped: no req_id in the premium init response');
    return null;
  }
  const link = await record(
    'get-gift-premium-link',
    await api('getGiftPremiumLink', linkFields(reqId, input.tonConnect)),
  );
  const facts = takeLink(link.response.body, result.secrets);
  result.linkPayloads.premium.push(...facts.payloads);
  if (facts.payTo === null) return 'the premium link response does not hold exactly one message';
  result.keepAddresses.push(...facts.payTo);
  result.payAddresses.premium.push(...facts.payTo);
  return null;
}
