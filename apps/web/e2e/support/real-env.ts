// The addresses of the real stack of the journeys, in one place.

/** Redis DB 13: the backend e2e suites use 15 and the dev API 0. */
export const REDIS_DB = 13;
export const REDIS_URL = `redis://localhost:6379/${String(REDIS_DB)}`;
