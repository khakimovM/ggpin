// `refId` of the two card-limit owner alerts (docs/05 alert table, D-45). The alert job id is
// `alert-<alert>-<refId>` and BullMQ drops an add whose id still exists, so the refId carries the
// card's LIMITS: after `card:limit` raises them, the card filling up again is a new event and is
// announced again, while replays at the same limits stay one alert.
//
//   cardFull       <cardId>_<receiveLimit>[_<monthlyLimit>]
//   cardNearLimit  <cardId>_80_<receiveLimit>[_<monthlyLimit>]
//
// Limits are tiyin written in base 36 (lowercase, no leading zero): a BigInt limit may have 19
// decimal digits, which with a 24-char cuid2 would not fit the 64-char refId segment; base 36
// needs at most 13. Card ids are capped at 32 characters here, so the longest ref is
// 32 + 4 + 13 + 1 + 13 = 63 characters and building never fails on a valid card.

export type CardLimitAlert = 'cardFull' | 'cardNearLimit';

export interface CardLimitRef {
  readonly cardId: string;
  readonly receiveLimitTiyin: bigint;
  readonly monthlyLimitTiyin: bigint | null;
}

const CARD_ID = /^[A-Za-z0-9]{1,32}$/; // cuid2: no '_', so the first '_' ends the id
const BASE36 = /^[1-9a-z][0-9a-z]{0,12}$/;
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const MAX_LIMIT = 9_223_372_036_854_775_807n; // Postgres BIGINT
const NEAR_LIMIT_MARK = '80';
const REF_MAX_LENGTH = 64;

function toBase36(value: bigint): string {
  if (value <= 0n || value > MAX_LIMIT) throw new Error('card limit out of range');
  let rest = value;
  let out = '';
  while (rest > 0n) {
    out = `${DIGITS.charAt(Number(rest % 36n))}${out}`;
    rest /= 36n;
  }
  return out;
}

function fromBase36(text: string): bigint | null {
  if (!BASE36.test(text)) return null;
  let value = 0n;
  for (const char of text) value = value * 36n + BigInt(DIGITS.indexOf(char));
  return value <= MAX_LIMIT ? value : null;
}

/** The refId of `alert` for this card at its current limits. */
export function cardLimitAlertRef(alert: CardLimitAlert, card: CardLimitRef): string {
  if (!CARD_ID.test(card.cardId)) throw new Error('cardLimitAlertRef: malformed card id');
  const parts = [card.cardId];
  if (alert === 'cardNearLimit') parts.push(NEAR_LIMIT_MARK);
  parts.push(toBase36(card.receiveLimitTiyin));
  if (card.monthlyLimitTiyin !== null) parts.push(toBase36(card.monthlyLimitTiyin));
  // At most 63 characters (see the header), within the notify refId segment.
  return parts.join('_');
}

/** The card and the limits a refId of `alert` names; null for anything malformed. */
export function parseCardLimitAlertRef(alert: CardLimitAlert, refId: string): CardLimitRef | null {
  if (refId.length > REF_MAX_LENGTH) return null;
  const parts = refId.split('_');
  const cardId = parts.shift();
  if (cardId === undefined || !CARD_ID.test(cardId)) return null;
  if (alert === 'cardNearLimit' && parts.shift() !== NEAR_LIMIT_MARK) return null;
  const [receiveText, monthlyText] = parts;
  if (receiveText === undefined || parts.length > 2) return null;
  const receive = fromBase36(receiveText);
  const monthly = monthlyText === undefined ? null : fromBase36(monthlyText);
  if (receive === null || (monthlyText !== undefined && monthly === null)) return null;
  return { cardId, receiveLimitTiyin: receive, monthlyLimitTiyin: monthly };
}
