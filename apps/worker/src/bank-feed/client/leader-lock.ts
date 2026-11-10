import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

/** The three atomic steps of a TTL lock owned by a token (Redis below, in memory in tests). */
export interface LockStore {
  /** SET key token PX ttl NX: true when taken. */
  acquire(key: string, token: string, ttlMs: number): Promise<boolean>;
  /** Extends the TTL only while the key still holds this token. */
  renew(key: string, token: string, ttlMs: number): Promise<boolean>;
  /** Deletes the key only while it still holds this token. */
  release(key: string, token: string): Promise<void>;
}

const RENEW_IF_OURS = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`;
const DELETE_IF_OURS = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

export class RedisLockStore implements LockStore {
  constructor(private readonly redis: Redis) {}

  async acquire(key: string, token: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.set(key, token, 'PX', ttlMs, 'NX')) === 'OK';
  }

  async renew(key: string, token: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.eval(RENEW_IF_OURS, 1, key, token, String(ttlMs))) === 1;
  }

  async release(key: string, token: string): Promise<void> {
    await this.redis.eval(DELETE_IF_OURS, 1, key, token);
  }
}

/**
 * The bank-feed leader lock (docs/05 §4: Redis `lock:bank-feed`, TTL 30 s, renewed every 10 s):
 * one MTProto connection per auth key, a second one would get AUTH_KEY_DUPLICATED. A worker
 * that cannot renew has lost it (Redis away, or the TTL ran out during a long pause) and must
 * drop its connection at once; a standby takes the lock when the TTL of a dead leader ends.
 *
 * Local lease (D-52): a renewal that hangs (Redis slow, the process paused) tells nothing, so the
 * holder also trusts the lock only while its last CONFIRMED renewal, counted from when it was
 * sent, is younger than TTL minus a margin: `isFresh`. Past that it must stop by itself, before
 * the key can expire and a standby connect. This is not a fencing token: Telegram cannot check
 * one, so one bank-feed replica is the rule until S11 (docs/10).
 */
export class LeaderLock {
  /** Random per process: another worker's renew or release never touches our lock. */
  readonly token = randomBytes(16).toString('hex');
  private held = false;
  /** When the last confirmed acquire/renew was SENT (epoch ms), or null. */
  private confirmedAt: number | null = null;

  constructor(
    private readonly store: LockStore,
    private readonly key: string,
    private readonly ttlMs: number,
    /**
     * The lease ends this long before the TTL would: half of it (15 s of 30 s), so the listener's
     * check every 10 s disconnects at the latest 25 s after the last confirmed renewal was sent.
     */
    private readonly marginMs: number = Math.floor(ttlMs / 2),
    private readonly now: () => number = Date.now,
  ) {}

  /** Held, and the last confirmed renewal is recent enough to trust (see the class comment). */
  isFresh(): boolean {
    return (
      this.held &&
      this.confirmedAt !== null &&
      this.now() - this.confirmedAt < this.ttlMs - this.marginMs
    );
  }

  get isHeld(): boolean {
    return this.held;
  }

  /** Takes the lock when free, renews it when ours. False: someone else leads (or Redis failed). */
  async hold(): Promise<boolean> {
    const sentAt = this.now();
    try {
      this.held = this.held
        ? await this.store.renew(this.key, this.token, this.ttlMs)
        : await this.store.acquire(this.key, this.token, this.ttlMs);
    } catch {
      // A lock we cannot confirm is a lock we do not hold (fail closed: no second connection).
      this.held = false;
    }
    this.confirmedAt = this.held ? sentAt : null;
    return this.held;
  }

  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    this.confirmedAt = null;
    try {
      await this.store.release(this.key, this.token);
    } catch {
      // Redis away: the TTL frees the key anyway.
    }
  }
}
