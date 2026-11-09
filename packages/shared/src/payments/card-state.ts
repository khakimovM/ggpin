import type { TopupCardStatus } from './bank-feed';

// The receiving-card status graph (docs/05 §2), shared by the API (card commands) and the worker
// (verification, FULL). The database guard knows only that RETIRED is final (GG001); everything
// else is decided here, so every status write goes through `assertCardTransition`.
//   VERIFYING -> ACTIVE   the test transfer arrived (worker, S6)
//   ACTIVE    -> FULL     limit reached (worker)        FULL -> ACTIVE  limit raised (setLimit)
//   ACTIVE|FULL -> DRAINING  ordinary retire: no new requests, issued ones stay payable
//   DRAINING  -> RETIRED  no request of the card (any status) has `reservedUntil >= now -
//                         LATE_STORED_AFTER_MS` (10 min: a payment made in time but stored late
//                         is still credited) and no message on it awaits a decision (worker,
//                         CardDrainService in the every-minute topup-expire sweep; alert
//                         `cardDrained`)
//   any but RETIRED -> RETIRED  emergency retire; VERIFYING has no requests, so it retires at once
const GRAPH: Readonly<Record<TopupCardStatus, readonly TopupCardStatus[]>> = Object.freeze({
  VERIFYING: Object.freeze<TopupCardStatus[]>(['ACTIVE', 'RETIRED']),
  ACTIVE: Object.freeze<TopupCardStatus[]>(['FULL', 'DRAINING', 'RETIRED']),
  FULL: Object.freeze<TopupCardStatus[]>(['ACTIVE', 'DRAINING', 'RETIRED']),
  DRAINING: Object.freeze<TopupCardStatus[]>(['RETIRED']),
  RETIRED: Object.freeze<TopupCardStatus[]>([]),
});

export class CardTransitionError extends Error {
  constructor(
    readonly from: TopupCardStatus,
    readonly to: TopupCardStatus,
  ) {
    super(`Illegal card transition ${from} -> ${to}`);
    this.name = 'CardTransitionError';
  }
}

export function canTransitionCard(from: TopupCardStatus, to: TopupCardStatus): boolean {
  return GRAPH[from].includes(to);
}

export function assertCardTransition(from: TopupCardStatus, to: TopupCardStatus): void {
  if (!canTransitionCard(from, to)) throw new CardTransitionError(from, to);
}
