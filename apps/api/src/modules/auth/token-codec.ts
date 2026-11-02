import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';

// Session tokens without a JWT library: `base64url(JSON payload) + '.' + base64url(HMAC-SHA256)`.
// There is no header and no `alg`, so there is nothing for an attacker to switch. The two
// channels use different secrets AND a `typ` claim, and a verifier is told which one it
// expects: a Mini App token can never pass as a web cookie, nor the other way round.

export type TokenType = 'web' | 'tg';

const payloadSchema = z.strictObject({
  typ: z.enum(['web', 'tg']),
  sub: z.string().min(1).max(64), // user id
  sid: z.string().min(1).max(64).optional(), // web: session family id
  iat: z.number().int().nonnegative(), // seconds
  exp: z.number().int().positive(), // seconds
});
export type TokenPayload = z.infer<typeof payloadSchema>;

// Tokens we issue are ~150 chars; anything near this limit is not ours. Checked before any
// hashing so an oversized value costs nothing.
export const TOKEN_MAX_LENGTH = 2048;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

@Injectable()
export class TokenCodec {
  private readonly secrets: Readonly<Record<TokenType, string>>;

  constructor(
    @Inject(APP_CONFIG) config: Pick<AppConfig, 'JWT_ACCESS_SECRET' | 'TG_SESSION_SECRET'>,
  ) {
    this.secrets = { web: config.JWT_ACCESS_SECRET, tg: config.TG_SESSION_SECRET };
  }

  sign(payload: TokenPayload): string {
    const body = Buffer.from(JSON.stringify(payloadSchema.parse(payload))).toString('base64url');
    return `${body}.${this.mac(payload.typ, body)}`;
  }

  /**
   * The payload when the token is authentic, of the expected type and not expired; otherwise
   * null, always the same null: the caller must not be able to tell (or leak) which check failed.
   */
  verify(token: string, expected: TokenType, now: Date): TokenPayload | null {
    if (token.length === 0 || token.length > TOKEN_MAX_LENGTH) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [body = '', signature = ''] = parts;
    if (!BASE64URL.test(body) || !BASE64URL.test(signature)) return null;

    // Authenticity first: nothing below runs on bytes the secret did not sign. The comparison is
    // over the encoded strings with equal lengths checked up front (timingSafeEqual throws on
    // a mismatch), so a short or long signature is a plain null, not an exception.
    const given = Buffer.from(signature);
    const wanted = Buffer.from(this.mac(expected, body));
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;

    const payload = parsePayload(body);
    if (payload === null || payload.typ !== expected) return null;
    if (payload.exp <= Math.floor(now.getTime() / 1000)) return null;
    return payload;
  }

  private mac(typ: TokenType, body: string): string {
    return createHmac('sha256', this.secrets[typ]).update(body).digest('base64url');
  }
}

function parsePayload(body: string): TokenPayload | null {
  try {
    const json: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const parsed = payloadSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
