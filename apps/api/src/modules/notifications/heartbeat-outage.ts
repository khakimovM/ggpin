import type { Queue } from 'bullmq';

export const WATCHDOG_EVERY_MS = 30_000;
const EPOCH_MS = /^\d{1,15}$/;

/** The part of the notify queue the watchdogs use (BullMQ's Queue; a fake in the unit tests). */
export type WatchdogQueue = Pick<Queue, 'add'>;

/**
 * One process heartbeat as the watchdog sees it (a slice of WatchdogRepository): is the key there,
 * and the API's own last sighting of it (epoch ms in Redis time, shared by every API instance).
 */
export interface HeartbeatSightings {
  present(): Promise<boolean>;
  lastSeen(): Promise<string | null>;
  storeLastSeen(epochMs: number): Promise<void>;
  /** Stores the sighting only if none exists (another instance may have just stored one). */
  storeLastSeenIfAbsent(epochMs: number): Promise<void>;
}

/** UP: the heartbeat is there; DOWN: gone, under the threshold; OVER: gone since `since`. */
export type HeartbeatOutage =
  | { readonly state: 'UP' }
  | { readonly state: 'DOWN' }
  | { readonly state: 'OVER'; readonly since: number };

/**
 * One look at a process heartbeat (workerDown, bankfeedDown). While the key is there, `now` is
 * stored as the last sighting. When it has been gone for `alertAfterMs` since that sighting, the
 * outage is OVER the threshold and `since` (the sighting) is the alert's refId: every later tick,
 * every other API instance and a restarted API build the SAME notify job id, and a new outage
 * after recovery is a new id. A sighting that cannot be trusted (unreadable, negative, or more
 * than one tick in the future: an edited key or a clock jump) is replaced by now, so it can never
 * silence the alert (audit L-1, P1). Never seen: counts from the first look (stored only if none
 * exists yet). `now` is Redis's clock (TIME).
 */
export async function lookAtHeartbeat(
  sightings: HeartbeatSightings,
  now: number,
  alertAfterMs: number,
): Promise<HeartbeatOutage> {
  if (await sightings.present()) {
    await sightings.storeLastSeen(now);
    return { state: 'UP' };
  }
  const stored = await sightings.lastSeen();
  let lastSeen = trustedSighting(stored, now);
  if (lastSeen === null) {
    // Never seen: count from now unless another instance just stored one. Untrusted: replace
    // it unconditionally (NX would keep a future value forever, audit P1).
    if (stored === null) await sightings.storeLastSeenIfAbsent(now);
    else await sightings.storeLastSeen(now);
    lastSeen = trustedSighting(await sightings.lastSeen(), now) ?? now;
  }
  if (now - lastSeen < alertAfterMs) return { state: 'DOWN' };
  return { state: 'OVER', since: lastSeen };
}

/** A sighting to count from: our own epoch ms, not past `now` by more than one tick. */
function trustedSighting(value: string | null, now: number): number | null {
  if (value === null || !EPOCH_MS.test(value)) return null;
  const ms = Number(value);
  return ms > now + WATCHDOG_EVERY_MS ? null : ms;
}
