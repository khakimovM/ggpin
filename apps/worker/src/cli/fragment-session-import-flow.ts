import { parseCookieInput, type FragmentJar } from '../adapters/fragment/fragment-cookie-jar';

// `fragment:session-import` (Q9, phase 5 S7): the owner's browser cookies for fragment.com become
// the ACTIVE FragmentSession, encrypted. They come on stdin only (never an argument: it would be
// in the shell history and the process list; never an env variable: it would be in the
// environment of every child). Nothing of a value is printed: only how many cookies, their NAMES
// (`stel_ssid`... are not secrets) and the new row id. The page `hash` is not asked for: the
// keep-alive reads it from the first logged-in page and stores it in the encrypted jar.

/** Cookies the S0b notes expect (guess); a missing one is a warning, not a refusal. */
export const EXPECTED_COOKIES = ['stel_ssid', 'stel_token'] as const;

export interface SessionImporter {
  importSession(jar: FragmentJar): Promise<string>;
}

export async function importFragmentSession(
  input: string,
  store: SessionImporter,
  say: (line: string) => void,
): Promise<string> {
  const cookies = parseCookieInput(input);
  const names = [...cookies.keys()].sort();
  const missing = EXPECTED_COOKIES.filter((name) => !cookies.has(name));
  if (missing.length > 0) say(`warning: no ${missing.join(', ')} cookie (expected, not required)`);
  const id = await store.importSession({ cookies, pageHash: null });
  say(`imported ${String(names.length)} cookies (${names.join(', ')}) as session ${id}`);
  say(
    'the previous ACTIVE session (if any) is now DEAD (REPLACED); the keep-alive checks the new one',
  );
  return id;
}
