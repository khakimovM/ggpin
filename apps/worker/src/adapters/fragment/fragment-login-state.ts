import { z } from 'zod';
import { detectPageMarkers, extractApiHash } from './fragment-page';

// "Am I logged in?" from a fragment.com page (phase 5 S7 keep-alive, docs/06). The markers are
// the S0b GUESSES (fragment-page.ts) until the owner's recording confirms them (S8); the tests use
// SYNTHETIC pages (simulator/synthetic-fragment-pages.ts) built on the same guesses. Fail-closed:
// a page that is clearly neither state is BAD_PAGE (a failure of the keep-alive), never "logged
// in". The page body is never logged or kept: only the state and the hash leave this function.

const LoggedInSchema = z.strictObject({
  state: z.literal('LOGGED_IN'),
  // The internal API needs it (S8): a logged-in page without it is not one we understand.
  apiHash: z.string().regex(/^[a-fA-F0-9]{6,64}$/),
});
const LoggedOutSchema = z.strictObject({ state: z.literal('LOGGED_OUT') });
const PageStateSchema = z.discriminatedUnion('state', [LoggedInSchema, LoggedOutSchema]);

export type FragmentPageState = z.infer<typeof PageStateSchema> | { readonly state: 'BAD_PAGE' };

export function fragmentPageState(html: string): FragmentPageState {
  const markers = detectPageMarkers(html);
  const account = markers.tgAccountMenu || markers.logoutAction;
  let candidate: unknown = { state: 'UNKNOWN' };
  if (account && !markers.loginButton) {
    candidate = { state: 'LOGGED_IN', apiHash: extractApiHash(html) };
  } else if (markers.loginButton && !account) {
    candidate = { state: 'LOGGED_OUT' };
  }
  const parsed = PageStateSchema.safeParse(candidate);
  return parsed.success ? parsed.data : { state: 'BAD_PAGE' };
}
