import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { LOGIN_NONCE_TTL_SEC } from '@repo/shared';
import { RedisService } from '../../../infra/redis/redis.service';
import { deviceLabel } from '../../auth/device-label';
import { maskIp } from '../../auth/mask-ip';

/** Where an admin login was started (SA-L4): shown in the bot's code message. */
export interface AdminLoginOrigin {
  /** IPv4 /24 or IPv6 /48, never the full address. */
  readonly ip: string | null;
  /** A label from a fixed list (device-label.ts), never the raw User-Agent. */
  readonly device: string | null;
}

// Keyed by sha256(nonce): whoever reads Redis learns nothing that opens the login request.
const key = (nonce: string): string =>
  `adm:login-origin:${createHash('sha256').update(nonce).digest('hex')}`;

function isOrigin(value: unknown): value is AdminLoginOrigin {
  if (typeof value !== 'object' || value === null) return false;
  const { ip, device } = value as Record<string, unknown>;
  return (ip === null || typeof ip === 'string') && (device === null || typeof device === 'string');
}

/**
 * Remembers, for the life of an admin login link, the masked address and device that opened it,
 * so the bot can show them next to the code ("is this you?", SA-L4). Best effort: without Redis
 * the code message shows dashes, the login itself does not depend on it.
 */
@Injectable()
export class AdminLoginOriginStore {
  private readonly logger = new Logger('AdminLogin');

  constructor(private readonly redis: RedisService) {}

  async remember(nonce: string, ip: string | null, userAgent: string | null): Promise<void> {
    const origin: AdminLoginOrigin = { ip: maskIp(ip), device: deviceLabel(userAgent) };
    try {
      await this.redis.client.set(key(nonce), JSON.stringify(origin), 'EX', LOGIN_NONCE_TTL_SEC);
    } catch (error) {
      this.warn(error);
    }
  }

  async read(nonce: string): Promise<AdminLoginOrigin | null> {
    try {
      const raw = await this.redis.client.get(key(nonce));
      if (raw === null) return null;
      const parsed: unknown = JSON.parse(raw);
      return isOrigin(parsed) ? parsed : null;
    } catch (error) {
      this.warn(error);
      return null;
    }
  }

  private warn(error: unknown): void {
    // Name only: a Redis error message can quote the connection URL.
    this.logger.warn(
      `login origin unavailable: ${error instanceof Error ? error.name : 'unknown'}`,
    );
  }
}
