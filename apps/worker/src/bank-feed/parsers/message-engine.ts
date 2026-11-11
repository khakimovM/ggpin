import { parseUzsAmount } from './amount';
import { parseBankDateTime } from './datetime';
import { classifyLine, type DirectionLine } from './markers';
import { MAX_MESSAGE_LENGTH, normalizeLines } from './normalize';
import {
  unrecognized,
  type BankParseResult,
  type ParseFailureReason,
  type ParsedBankMessage,
} from './parse-result';
import { exactTitleDirections, titleHints, type KnownTitle } from './title';

/** What differs between the bots: the card line shape and the titles whose meaning we know. */
export interface BankProfile {
  /** The whole card value after the marker; its last 4 characters are the digits. */
  readonly cardPattern: RegExp;
  readonly titles: readonly KnownTitle[];
}

export const MAX_CHANNEL_LENGTH = 200;

// Characters a channel must never carry, refused rather than stripped: control characters
// (NUL, ESC, DEL, C1 ...) and bidi controls could rewrite a terminal or reorder text when the
// owner reads it (review:show); lone surrogates are not text; tag characters (U+E0000..U+E007F)
// and invisible format characters (soft hyphen, ZWSP, word joiner, BOM, interlinear
// annotation U+FFF9..U+FFFB) can hide content from the owner.
const UNSAFE_CHANNEL_CHARACTER =
  /[\p{Cc}\p{Cs}\u{061C}\u{00AD}\u{200B}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2060}\u{2066}-\u{2069}\u{FEFF}\u{FFF9}-\u{FFFB}\u{E0000}-\u{E007F}]/u;

interface Collected {
  readonly directions: DirectionLine[];
  readonly cards: string[];
  readonly times: string[];
  readonly balances: string[];
  // One entry per channel marker; unmarked lines right after it are its continuation lines.
  readonly channels: string[][];
}

type Single<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ParseFailureReason };

/**
 * The language-independent parser both bots share (docs/05-PAYMENTS.md §5). Each line is
 * classified by its leading marker only, so the order of the field lines does not matter; the
 * checks below run in a fixed order, so the same set of lines always yields the same result
 * (also the same failure reason). Fail-closed: anything not exactly as expected is UNRECOGNIZED,
 * and an unrecognised message never reaches a wallet.
 *
 * Why the line order is NOT enforced (review decision, S5): the layout of every message type is
 * known only from two screenshots, and a strict order would turn a harmless layout change into a
 * stream of reviews. A forged line gains nothing from this freedom: every field must occur
 * exactly once, so an injected second amount or balance is a DUPLICATE_*, and the balance is then
 * proven by the per-card balance chain (S6): it must equal the previous balance plus or minus the
 * amount exactly, otherwise BREAK pauses auto-credit on the card (fail-closed).
 *
 * The parser never logs, evaluates or interpolates the text anywhere.
 */
export function parseWithProfile(text: string, profile: BankProfile): BankParseResult {
  if (text.length > MAX_MESSAGE_LENGTH) return unrecognized('TOO_LONG');
  const lines = normalizeLines(text);
  const [first, ...rest] = lines;
  if (first === undefined) return unrecognized('EMPTY');

  // The title is the first line when it carries no field marker (the bot's emoji + heading).
  const hasTitle = classifyLine(first) === null;
  const collected = collect(hasTitle ? rest : lines);
  if (collected === null) return unrecognized('UNEXPECTED_LINE');

  const directionLine = exactlyOne(
    collected.directions,
    'MISSING_DIRECTION',
    'DUPLICATE_DIRECTION',
  );
  if (!directionLine.ok) return unrecognized(directionLine.reason);
  const card = exactlyOne(collected.cards, 'MISSING_CARD', 'DUPLICATE_CARD');
  if (!card.ok) return unrecognized(card.reason);
  const time = exactlyOne(collected.times, 'MISSING_TIME', 'DUPLICATE_TIME');
  if (!time.ok) return unrecognized(time.reason);
  const balance = exactlyOne(collected.balances, 'MISSING_BALANCE', 'DUPLICATE_BALANCE');
  if (!balance.ok) return unrecognized(balance.reason);
  if (collected.channels.length > 1) return unrecognized('DUPLICATE_CHANNEL');

  const amountTiyin = parseUzsAmount(directionLine.value.value);
  // A zero transfer is not a payment; treat it as a shape we do not know.
  if (amountTiyin === null || amountTiyin === 0n) return unrecognized('AMOUNT_FORMAT');
  const balanceAfterTiyin = parseUzsAmount(balance.value);
  if (balanceAfterTiyin === null) return unrecognized('BALANCE_FORMAT');
  if (!profile.cardPattern.test(card.value)) return unrecognized('CARD_FORMAT');
  const bankTxnAt = parseBankDateTime(time.value);
  if (!bankTxnAt.ok) return unrecognized(bankTxnAt.reason);
  const channel = joinChannel(collected.channels[0]);
  if (channel !== null && UNSAFE_CHANNEL_CHARACTER.test(channel)) {
    return unrecognized('CHANNEL_FORMAT');
  }
  if (channel !== null && [...channel].length > MAX_CHANNEL_LENGTH) {
    return unrecognized('CHANNEL_TOO_LONG');
  }

  const direction = directionLine.value.direction;
  const hints = hasTitle ? titleHints(first, profile.titles) : [];
  if (hints.some((hint) => hint !== direction)) return unrecognized('DIRECTION_CONFLICT');

  const parsed: ParsedBankMessage = {
    ok: true,
    direction,
    amountTiyin,
    balanceAfterTiyin,
    last4: card.value.slice(-4),
    bankTxnAt: bankTxnAt.at,
    channel,
    titleHint: hints.length > 0 ? direction : null,
    titleKnown: hasTitle && exactTitleDirections(first, profile.titles).length > 0,
  };
  return parsed;
}

function collect(lines: readonly string[]): Collected | null {
  const collected: Collected = { directions: [], cards: [], times: [], balances: [], channels: [] };
  let openChannel: string[] | null = null;
  for (const line of lines) {
    const marked = classifyLine(line);
    if (marked === null) {
      // Only a channel may run over several lines (Uzcard); any other stray line is unknown.
      if (openChannel === null) return null;
      openChannel.push(line);
      continue;
    }
    openChannel = null;
    if (marked.kind === 'DIRECTION') collected.directions.push(marked);
    else if (marked.kind === 'CARD') collected.cards.push(marked.value);
    else if (marked.kind === 'TIME') collected.times.push(marked.value);
    else if (marked.kind === 'BALANCE') collected.balances.push(marked.value);
    else {
      openChannel = [marked.value];
      collected.channels.push(openChannel);
    }
  }
  return collected;
}

function exactlyOne<T>(
  items: readonly T[],
  missing: ParseFailureReason,
  duplicate: ParseFailureReason,
): Single<T> {
  const [item, ...others] = items;
  if (item === undefined) return { ok: false, reason: missing };
  if (others.length > 0) return { ok: false, reason: duplicate };
  return { ok: true, value: item };
}

function joinChannel(parts: readonly string[] | undefined): string | null {
  const joined = (parts ?? []).filter((part) => part.length > 0).join(' ');
  return joined.length > 0 ? joined : null;
}
