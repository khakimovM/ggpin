import type { BankFeedSource } from '@repo/shared';
import { parseHumoMessage } from './humo.parser';
import type { BankParseResult } from './parse-result';
import { parseUzcardMessage } from './uzcard.parser';

// The source is decided by the listener from the pinned numeric bot id (docs/05-PAYMENTS.md §4),
// never from the text: a message cannot pick its own parser. Record<> makes a new source without
// a parser a compile error.
const PARSERS: Readonly<Record<BankFeedSource, (text: string) => BankParseResult>> = {
  HUMO_BOT: parseHumoMessage,
  UZCARD_BOT: parseUzcardMessage,
};

/**
 * Entry point for the ingest step. Pure: no I/O, no logging; never throws for any string.
 * Store `PARSER_VERSION` (./parser-version) next to the result on every `BankMessage` row.
 */
export function parseBankMessage(source: BankFeedSource, text: string): BankParseResult {
  return PARSERS[source](text);
}
