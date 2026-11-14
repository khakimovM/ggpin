import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { LockStore } from '../bank-feed/client/leader-lock';

// The cooperative wallet lock `lock:ton-wallet` (docs/06, plan 6.4 step 1): one sender at a time
// per hot wallet, held from the seqno read through the confirmation and renewed on every poll.
// It is only an optimisation: the real fence is the database (one unresolved transfer per wallet,
// one live transfer per seqno), so a lost lease can never produce a second message. A Redis that
// cannot answer before signing is fail-closed: TonLockUnavailableError, nothing signed, the job
// retries later.

export class TonLockUnavailableError extends Error {
  constructor() {
    super('the TON wallet lock cannot be taken: Redis is not answering (nothing was signed)');
    this.name = 'TonLockUnavailableError';
  }
}

export class TonLease {
  private readonly logger = new Logger(TonLease.name);

  constructor(
    private readonly store: LockStore,
    private readonly key: string,
    private readonly token: string,
    private readonly ttlMs: number,
  ) {}

  /** False when the lease is gone (expired or Redis away); the DB fence still holds. */
  async renew(): Promise<boolean> {
    try {
      const kept = await this.store.renew(this.key, this.token, this.ttlMs);
      if (!kept) this.logger.warn('the TON wallet lock lease was lost; the DB fence still holds');
      return kept;
    } catch {
      this.logger.warn(
        'the TON wallet lock could not be renewed (Redis); the DB fence still holds',
      );
      return false;
    }
  }

  async release(): Promise<void> {
    try {
      await this.store.release(this.key, this.token);
    } catch {
      // Redis away: the TTL frees the key.
    }
  }
}

export class TonWalletLock {
  constructor(
    private readonly store: LockStore,
    private readonly key: string,
    private readonly ttlMs: number,
  ) {}

  /** The lease, or null when another sender holds the wallet. Throws when Redis cannot answer. */
  async acquire(): Promise<TonLease | null> {
    const token = randomBytes(16).toString('hex');
    let taken: boolean;
    try {
      taken = await this.store.acquire(this.key, token, this.ttlMs);
    } catch {
      throw new TonLockUnavailableError();
    }
    return taken ? new TonLease(this.store, this.key, token, this.ttlMs) : null;
  }
}
