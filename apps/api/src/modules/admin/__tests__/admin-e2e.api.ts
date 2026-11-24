import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { MonotonicClock } from '../../../common/admin/admin-deadline';
import type { AdminRole, AdminUser } from '@repo/db';
import type { CaptureStream } from '../../../common/logging/__tests__/capture-stream';
import type { Env } from '../../../config/env';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { MutableClock } from '../../auth/__tests__/auth-e2e.helpers';
import type { FakeTelegram } from '../../telegram/__tests__/fake-telegram-api';
import type { AdminIssueCodeResult } from '../auth/admin-login.service';

// What the admin e2e harness (admin-e2e.harness.ts) hands a suite.
export const ADMIN_BASE = '/api/v1/admin/auth';
export const OWNER_CHATS = ['700000011', '700000012'] as const;

export type Inject = ReturnType<NestFastifyApplication['inject']>;
export type Res = Awaited<Inject>;

export interface AdminE2e {
  readonly env: Env;
  readonly clock: MutableClock;
  readonly logs: CaptureStream;
  readonly cookieName: string;
  /** ADMIN_TELEGRAM_IDS as the running app reads it on every request: edit it to "redeploy". */
  readonly allowlist: bigint[];
  readonly db: () => PrismaService['client'];
  readonly app: () => NestFastifyApplication;
  readonly nextIp: () => string;
  readonly newAdmin: (
    role: AdminRole,
    opts?: { allowlisted?: boolean; active?: boolean },
  ) => Promise<AdminUser>;
  readonly trackNonce: (nonce: string) => void;
  /** An admin row made outside newAdmin (the CLI): removed in cleanup like the others. */
  readonly trackAdmin: (admin: { id: string; telegramId: bigint }) => void;
  /** The admin SPA's headers: Origin = ADMIN_URL, a fetch in cors mode, and the CSRF header. */
  readonly spa: (extra?: Record<string, string>) => Record<string, string>;
  readonly request: (
    method: 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    headers?: Record<string, string>,
    ip?: string,
    payload?: object,
  ) => Inject;
  readonly start: (ip?: string) => Promise<string>;
  readonly issue: (nonce: string, telegramId: bigint) => Promise<AdminIssueCodeResult>;
  readonly verify: (nonce: string, code: string, ip?: string) => Inject;
  /** start -> bot code -> verify; returns the session cookie header (`name=value`). */
  readonly login: (admin: AdminUser) => Promise<{ cookie: string; token: string; res: Res }>;
  /** A store user signed in on the web (WEB_URL): its access token, for cross-surface checks. */
  readonly loginUser: () => Promise<string>;
  /** A suite's own clean-up, run first in the harness's afterAll while the app still runs. */
  readonly onClose: (close: () => Promise<unknown>) => void;
  /** One Telegram update through the real webhook (needs the `bot` option). */
  readonly webhook: (update: object) => Inject;
}

export const WEBHOOK_PATH = '/api/v1/telegram/webhook';

export function setCookies(res: Res): string[] {
  const raw = res.headers['set-cookie'];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

// Boots the real AppModule on the `*_test` database with a movable clock, a captured log
// stream, two synthetic owner chats and a mutable allowlist. Cleans only what it created;
// AuditLog rows are append-only and stay.
export interface AdminE2eOptions {
  /** Default test. production / development run on the test database too (cookie checks). */
  readonly nodeEnv?: 'production' | 'development' | 'test';
  /** Runs the bot in webhook mode on this fake Bot API (the outbox sender is stubbed too). */
  readonly bot?: FakeTelegram;
  /** Replaces MONOTONIC_CLOCK (the admin write deadline's clock), on performance.now()'s line. */
  readonly monotonicClock?: MonotonicClock;
}
