// The per-card advisory lock (docs/05 §3). Everything that changes a receiving card's amounts or
// status takes it inside its transaction: the API when it allocates a unique amount or runs a
// card command, the worker when it changes a card's status or turns an intent on the card into
// PAID. The key is text, hashed by Postgres: `pg_advisory_xact_lock(hashtext(<key>))`. Never two
// card locks in one transaction, so lock order cannot deadlock.

const CARD_ID = /^[A-Za-z0-9_]{1,64}$/;

/** The text key of `cardId`'s advisory lock; one spelling for the API and the worker. */
export function topupCardLockKey(cardId: string): string {
  // A malformed id would silently lock a key nobody else uses: fail loudly instead.
  if (!CARD_ID.test(cardId)) throw new Error('topupCardLockKey: malformed card id');
  return `topup-card:${cardId}`;
}

const HOUR_MS = 3_600_000;
const RESERVED_HIGH_REF = /^([A-Za-z0-9_]+)_(\d{1,12})$/;
const REF_MAX_LENGTH = 64; // the notify job's refId segment (notify.ts)

/**
 * `refId` of the `cardReservedHigh` owner alert (D-42 (1)): `<cardId>_<epoch hour>`, so one
 * alert per card per clock hour (BullMQ drops a job whose id already exists). The API builds it,
 * the notify renderer (S6) parses the card back out of it.
 */
export function cardReservedHighRef(cardId: string, now: Date): string {
  if (!CARD_ID.test(cardId)) throw new Error('cardReservedHighRef: malformed card id');
  const ref = `${cardId}_${String(Math.floor(now.getTime() / HOUR_MS))}`;
  if (ref.length > REF_MAX_LENGTH) throw new Error('cardReservedHighRef: card id too long');
  return ref;
}

/** The card and the hour of a `cardReservedHigh` refId; null for anything else. */
export function parseCardReservedHighRef(
  refId: string,
): { readonly cardId: string; readonly hourStart: Date } | null {
  if (refId.length > REF_MAX_LENGTH) return null;
  const match = RESERVED_HIGH_REF.exec(refId);
  const cardId = match?.[1];
  const hour = match?.[2];
  if (cardId === undefined || hour === undefined) return null;
  return { cardId, hourStart: new Date(Number(hour) * HOUR_MS) };
}
