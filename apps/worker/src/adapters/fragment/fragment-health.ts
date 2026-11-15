import { Injectable } from '@nestjs/common';
import {
  FRAGMENT_HEALTH_KEY,
  FRAGMENT_HEALTH_VALUES,
  type AdapterHealth,
  type FragmentHealthValue,
} from '@repo/shared';
import { RedisService } from '../../infra/redis/redis.service';
import { FragmentSessionRepository } from './fragment-session.repository';

// Fragment session health (phase 5 S7, plan §7), in two places:
//
// - Redis `fragment:health` = `ok` | `down`, written by the keep-alive with a TTL of a few
//   periods, so a keep-alive that stopped running reads as no value (the API's `/health/ready`
//   then says `disabled`, docs/04; the shape of that answer does not change).
// - The database row: ACTIVE, or a session the keep-alive declared DEAD (deadAt).
//
// The Redis value is for the API (it holds no database connection to the session table, docs/04
// shape unchanged). The worker's own `read()` decides by the DATABASE only (S7 review m2): `ok`
// while a session is ACTIVE, `down` when the newest death has no ACTIVE successor, `disabled` when
// there never was a session. So a session imported after a death is used at once (within the
// router's HEALTH_CACHE_MS), not after the Redis `down` of the dead one runs out; the API's view
// catches up on the keep-alive's next look (at most one period).

export type FragmentSessionHealth = FragmentHealthValue | 'disabled';

/** How many keep-alive periods a published value outlives the keep-alive that wrote it. */
export const HEALTH_TTL_PERIODS = 3;

function healthValue(raw: string | null): FragmentHealthValue | null {
  return FRAGMENT_HEALTH_VALUES.find((v) => v === raw) ?? null;
}

@Injectable()
export class FragmentHealth {
  constructor(
    private readonly redis: RedisService,
    private readonly sessions: FragmentSessionRepository,
  ) {}

  /** The keep-alive's verdict; null removes it (no session at all). */
  async publish(value: FragmentHealthValue | null, ttlMs: number): Promise<void> {
    if (value === null) await this.redis.client.del(FRAGMENT_HEALTH_KEY);
    else await this.redis.client.set(FRAGMENT_HEALTH_KEY, value, 'PX', ttlMs);
  }

  /** What the keep-alive last published (the API's view), or null when nothing is current. */
  async published(): Promise<FragmentHealthValue | null> {
    return healthValue(await this.redis.client.get(FRAGMENT_HEALTH_KEY));
  }

  /** Throws when the database cannot be read: the router then treats it as unhealthy. */
  async read(): Promise<FragmentSessionHealth> {
    const state = await this.sessions.state();
    if (state === 'ACTIVE') return 'ok';
    return state === 'DEAD' ? 'down' : 'disabled';
  }

  /**
   * For the real Fragment adapter (S8): only an ACTIVE session row can reach Fragment (decided by
   * the database, like `read()`; the Redis value plays no part here); a dead session or no
   * session at all is DOWN.
   */
  async liveAdapterHealth(): Promise<AdapterHealth> {
    return (await this.read()) === 'ok' ? 'OK' : 'DOWN';
  }

  /**
   * For the dry-run Fragment simulator (criterion 5): the simulated Fragment is "logged in" unless
   * the keep-alive declared the session dead, so a dev worker without any session still routes
   * Stars to FRAGMENT, and a DEAD session sends them to the backup route.
   */
  async simulatedAdapterHealth(): Promise<AdapterHealth> {
    return (await this.read()) === 'down' ? 'DOWN' : 'OK';
  }
}
