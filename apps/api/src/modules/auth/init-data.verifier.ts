import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';

// Telegram Mini App launch-parameter validation, exactly as documented at
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app :
//   data_check_string = every received field except `hash`, sorted by key, "key=value", joined
//                       with "\n" (the `signature` field IS part of it);
//   secret_key        = HMAC_SHA256(key = "WebAppData", msg = bot token);
//   hash              = hex(HMAC_SHA256(key = secret_key, msg = data_check_string)).
// Freshness (`auth_date`) is a policy on top of the documented check, not part of it.

/** Allowed clock skew for an `auth_date` that is ahead of our clock. */
export const AUTH_DATE_FUTURE_SKEW_SEC = 60;

const HASH_FORMAT = /^[0-9a-f]{64}$/;
const AUTH_DATE_FORMAT = /^\d{1,12}$/;

const userSchema = z.object({
  id: z.int().positive(), // z.int() is a safe integer; Telegram ids fit in 52 bits
  first_name: z.string().min(1).max(256),
  last_name: z.string().max(256).optional(),
  username: z.string().max(64).optional(),
  language_code: z.string().max(35).optional(),
  photo_url: z
    .url({ protocol: /^https$/ })
    .max(1024)
    .optional(),
});

export interface InitDataUser {
  readonly id: bigint;
  readonly firstName: string;
  readonly lastName?: string;
  readonly username?: string;
  readonly languageCode?: string;
  readonly photoUrl?: string;
}

export interface VerifiedInitData {
  readonly user: InitDataUser;
  readonly startParam?: string;
  readonly authDate: Date;
}

@Injectable()
export class InitDataVerifier {
  private readonly secretKey: Buffer;
  private readonly maxAgeSec: number;

  constructor(
    @Inject(APP_CONFIG) config: Pick<AppConfig, 'TELEGRAM_BOT_TOKEN' | 'TG_INITDATA_MAX_AGE_SEC'>,
  ) {
    this.secretKey = createHmac('sha256', 'WebAppData').update(config.TELEGRAM_BOT_TOKEN).digest();
    this.maxAgeSec = config.TG_INITDATA_MAX_AGE_SEC;
  }

  /** Throws AppError INITDATA_INVALID or INITDATA_EXPIRED. Never echoes the input. */
  verify(initData: string, now: Date): VerifiedInitData {
    const fields = this.parseFields(initData);
    this.checkHash(fields);

    // Only authentic data reaches the freshness check, so a forged old payload is INVALID,
    // and "expired" is not an oracle for unsigned input.
    const authDate = this.readAuthDate(fields, now);
    const user = this.readUser(fields);
    const startParam = fields.get('start_param');
    return {
      user,
      authDate,
      ...(startParam !== undefined ? { startParam } : {}),
    };
  }

  // A repeated key would let two parsers disagree about which value was signed: reject it.
  private parseFields(initData: string): Map<string, string> {
    const fields = new Map<string, string>();
    for (const [key, value] of new URLSearchParams(initData)) {
      if (fields.has(key)) throw invalid();
      fields.set(key, value);
    }
    return fields;
  }

  private checkHash(fields: ReadonlyMap<string, string>): void {
    const hash = fields.get('hash');
    // Format and length first: timingSafeEqual throws on buffers of different sizes.
    if (hash === undefined || !HASH_FORMAT.test(hash)) throw invalid();

    const dataCheckString = [...fields.entries()]
      .filter(([key]) => key !== 'hash')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const expected = createHmac('sha256', this.secretKey).update(dataCheckString).digest();
    if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) throw invalid();
  }

  private readAuthDate(fields: ReadonlyMap<string, string>, now: Date): Date {
    const raw = fields.get('auth_date');
    if (raw === undefined || !AUTH_DATE_FORMAT.test(raw)) throw invalid();
    const authSec = Number(raw);
    const nowSec = Math.floor(now.getTime() / 1000);
    if (authSec > nowSec + AUTH_DATE_FUTURE_SKEW_SEC) throw invalid();
    if (nowSec - authSec > this.maxAgeSec) throw new AppError('INITDATA_EXPIRED');
    return new Date(authSec * 1000);
  }

  private readUser(fields: ReadonlyMap<string, string>): InitDataUser {
    const raw = fields.get('user');
    if (raw === undefined) throw invalid();
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw invalid();
    }
    const parsed = userSchema.safeParse(json);
    if (!parsed.success) throw invalid();
    const u = parsed.data;
    return {
      id: BigInt(u.id),
      firstName: u.first_name,
      ...(u.last_name !== undefined ? { lastName: u.last_name } : {}),
      ...(u.username !== undefined ? { username: u.username } : {}),
      ...(u.language_code !== undefined ? { languageCode: u.language_code } : {}),
      ...(u.photo_url !== undefined ? { photoUrl: u.photo_url } : {}),
    };
  }
}

function invalid(): AppError {
  return new AppError('INITDATA_INVALID');
}
