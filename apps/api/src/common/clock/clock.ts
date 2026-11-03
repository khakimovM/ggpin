// The current time as a dependency. Expiry rules (OTP codes, tokens, quotes) compare against
// `clock.now()` passed into queries, never SQL now() or a bare `new Date()`, so tests can move
// time instead of sleeping.
export const CLOCK = Symbol('CLOCK');

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
