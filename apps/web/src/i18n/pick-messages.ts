import type { Locale } from '@repo/shared';
import { MESSAGES, type Messages } from './messages';

/** The listed top-level namespaces of a locale's catalog, and nothing else. */
export function pickMessages<K extends keyof Messages>(
  locale: Locale,
  namespaces: readonly K[],
): Pick<Messages, K> {
  const catalog: Messages = MESSAGES[locale];
  const picked = {} as Pick<Messages, K>;
  for (const namespace of namespaces) picked[namespace] = catalog[namespace];
  return picked;
}
