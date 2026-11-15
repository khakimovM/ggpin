import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { WORKER_CONFIG, type WorkerConfig } from '../../config/config.module';
import { AdapterRouter } from '../../fulfillment/adapter-router';
import { FRAGMENT_ADAPTER } from '../../pricing-sync/cost-sources/cost-source';
import { FragmentHealth, HEALTH_TTL_PERIODS } from './fragment-health';
import { FragmentNotifier, deathRef } from './fragment-notifier';
import type { FragmentProbe, KeepaliveFailure } from './fragment-probe';
import { FragmentSessionRepository, type SessionRow } from './fragment-session.repository';

// The Fragment keep-alive (phase 5 S7, docs/06 "Fragment sessiyasi", plan §7). Every period:
//
// ACTIVE session
//   page logged in      -> lastOkAt, lastError cleared, Redis `ok`; the first OK of a newly
//                          imported session after a death -> `fragmentSessionRestored` (that death)
//   1st failure in a row -> lastError = code, still ACTIVE (one blip is not a death)
//   2nd failure in a row -> DEAD + deadAt (CAS), Redis `down`, `fragmentSessionDead`, the session's
//                          lifetime logged, the router's cached FRAGMENT health dropped
// no ACTIVE, newest death
//   the dead alert again (same id: dropped unless the first add was lost), Redis `down`; its page
//   logged in again (an outage, not a logout) -> ACTIVE again, `fragmentSessionRestored`
// no session at all -> the Redis value is removed (the API shows `disabled`)
//
// One alert per death: the refId is `<sessionId>_<deadAt ms>` (fragment-notifier.ts). Logs carry
// the session id, the failure code and durations only: never a cookie, the hash or a page.
// NO_KEY (this worker has no session key) and BAD_BLOB (the blob does not open with this key:
// imported with another key?) are configuration faults, not a logout: each also gets an error line
// of its own code (audit L-4); the owner's alert text is unchanged (its i18n is S10's). At boot
// the key's fingerprint is logged (8 hex, the import CLI prints the same), never the key.

export const FRAGMENT_PROBE = Symbol('FRAGMENT_PROBE');

export type KeepaliveResult = 'DISABLED' | 'NONE' | 'OK' | 'FAILING' | 'DEAD' | 'RESTORED';

/** The log codes of the two configuration faults (see above). */
export const KEY_FAULT_LOG: Readonly<Partial<Record<KeepaliveFailure, string>>> = {
  NO_KEY: 'FRAGMENT_SESSION_NO_KEY: FRAGMENT_SESSION_ENC_KEY(_FILE) is not configured here',
  BAD_BLOB:
    'FRAGMENT_SESSION_BAD_BLOB: the session does not open with this key ' +
    '(compare the key fingerprints of the import and of this worker)',
};

@Injectable()
export class FragmentKeepaliveService implements OnModuleInit {
  private readonly logger = new Logger(FragmentKeepaliveService.name);

  constructor(
    private readonly sessions: FragmentSessionRepository,
    private readonly health: FragmentHealth,
    private readonly notifier: FragmentNotifier,
    private readonly router: AdapterRouter,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Optional() @Inject(FRAGMENT_PROBE) private readonly probe: FragmentProbe | null = null,
  ) {}

  onModuleInit(): void {
    const key = this.config.FRAGMENT_SESSION_ENC_KEY;
    if (key !== undefined) this.logger.log(`fragment session key fingerprint ${key.fingerprint()}`);
  }

  private get ttlMs(): number {
    return this.config.FRAGMENT_KEEPALIVE_EVERY_MS * HEALTH_TTL_PERIODS;
  }

  async tick(now: Date = new Date()): Promise<KeepaliveResult> {
    if (this.probe === null) return 'DISABLED';
    const active = await this.sessions.active();
    if (active !== null) return this.checkActive(this.probe, active, now);
    const dead = await this.sessions.latestDeath();
    if (dead !== null) return this.checkDead(this.probe, dead, now);
    await this.health.publish(null, this.ttlMs);
    return 'NONE';
  }

  private async checkActive(probe: FragmentProbe, session: SessionRow, now: Date) {
    const outcome = await probe.check(session);
    if (outcome.kind === 'FAIL') this.logKeyFault(session.id, outcome.code);
    if (outcome.kind === 'OK') {
      if (!(await this.sessions.markOk(session.id, now))) return 'NONE';
      await this.health.publish('ok', this.ttlMs);
      if (session.lastOkAt === null) await this.restoredByImport(session);
      return 'OK';
    }
    if (session.lastError === null) {
      if (await this.sessions.markFirstFailure(session.id, outcome.code)) {
        this.logger.warn(`fragment session ${session.id}: keep-alive failed (${outcome.code})`);
      }
      await this.health.publish('ok', this.ttlMs);
      return 'FAILING';
    }
    return this.die(session, outcome.code, now);
  }

  private async die(session: SessionRow, code: KeepaliveFailure, now: Date) {
    const dead = await this.sessions.markDead(session.id, code, now);
    if (dead === null || dead.deadAt === null) return 'NONE';
    const deadAt = dead.deadAt;
    this.router.forgetHealth(FRAGMENT_ADAPTER);
    await this.health.publish('down', this.ttlMs);
    const hours = (deadAt.getTime() - session.createdAt.getTime()) / 3_600_000;
    this.logger.error(
      `fragment session ${session.id} is DEAD (${code}) after ${hours.toFixed(1)} h; ` +
        'Stars/Premium go to the backup route; import a new session (fragment:session-import)',
    );
    await this.notifier.alert('fragmentSessionDead', deathRef(session.id, deadAt));
    return 'DEAD';
  }

  private async checkDead(probe: FragmentProbe, session: SessionRow, now: Date) {
    const deadAt = session.deadAt;
    if (deadAt === null) return 'NONE';
    const ref = deathRef(session.id, deadAt);
    await this.notifier.alert('fragmentSessionDead', ref);
    await this.health.publish('down', this.ttlMs);
    const outcome = await probe.check(session);
    if (outcome.kind !== 'OK') {
      this.logKeyFault(session.id, outcome.code);
      return 'DEAD';
    }
    if (!(await this.sessions.revive(session.id, deadAt, now))) return 'DEAD';
    this.router.forgetHealth(FRAGMENT_ADAPTER);
    await this.health.publish('ok', this.ttlMs);
    const minutes = (now.getTime() - deadAt.getTime()) / 60_000;
    this.logger.log(
      `fragment session ${session.id} is ACTIVE again after ${minutes.toFixed(0)} min`,
    );
    await this.notifier.alert('fragmentSessionRestored', ref);
    return 'RESTORED';
  }

  private logKeyFault(sessionId: string, code: KeepaliveFailure): void {
    const line = KEY_FAULT_LOG[code];
    if (line !== undefined) this.logger.error(`fragment session ${sessionId}: ${line}`);
  }

  /** A new session's first OK after a death: the owner hears that this death is over. */
  private async restoredByImport(session: SessionRow): Promise<void> {
    const death = await this.sessions.predecessor(session);
    if (death === null || death.status !== 'DEAD' || death.deadAt === null) return;
    this.router.forgetHealth(FRAGMENT_ADAPTER);
    this.logger.log(`fragment session ${session.id} replaces the dead session ${death.id}`);
    await this.notifier.alert('fragmentSessionRestored', deathRef(death.id, death.deadAt));
  }
}
