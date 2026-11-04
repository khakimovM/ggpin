import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  RECIPIENT_TOKEN_TTL_MS,
  RecipientTokenRecordSchema,
  type Recipient,
  type RecipientTokenRecord,
} from '@repo/shared';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { RedisService } from '../../infra/redis/redis.service';

const TOKEN_BYTES = 32;

/** Redis key of a token: the SHA-256 of the token, never the token itself. */
export function recipientTokenKey(token: string): string {
  return `rcpt:${createHash('sha256').update(token).digest('hex')}`;
}

/**
 * Binds a validated recipient to (user, product) for 10 minutes. `/recipients/validate`
 * (phase 5) issues the token; `POST /quotes` resolves it. Only a SHA-256 of the token is a
 * Redis key, so a Redis dump or a `KEYS` call yields nothing a client could replay.
 *
 * Redis outage: both methods let the driver error propagate. `issue` cannot hand out a token
 * it did not store, and `resolve` must never answer "valid" (or even "unknown") when it could
 * not look: the caller sees a 500 and retries, nobody gets a quote for an unchecked recipient.
 */
@Injectable()
export class RecipientTokenStore {
  constructor(
    private readonly redis: RedisService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** A fresh 43-char base64url token for this user, product and recipient. */
  async issue(userId: string, productId: string, recipient: Recipient): Promise<string> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const record: RecipientTokenRecord = {
      userId,
      productId,
      recipient,
      issuedAt: this.clock.now().toISOString(),
    };
    await this.redis.client.set(
      recipientTokenKey(token),
      JSON.stringify(record),
      'PX',
      RECIPIENT_TOKEN_TTL_MS,
    );
    return token;
  }

  /**
   * The record, or null when the token is unknown, expired, unreadable, or was issued to
   * another user or for another product. All of those are the same answer on purpose (no
   * oracle). Not consumed: the user may quote another pack for the same recipient until the
   * token expires. The key is a hash lookup, so no secret is compared byte by byte here.
   */
  async resolve(
    token: string,
    userId: string,
    productId: string,
  ): Promise<RecipientTokenRecord | null> {
    const raw = await this.redis.client.get(recipientTokenKey(token));
    if (raw === null) return null;
    const record = parseRecord(raw);
    if (record === null) return null;
    return record.userId === userId && record.productId === productId ? record : null;
  }
}

function parseRecord(raw: string): RecipientTokenRecord | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = RecipientTokenRecordSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
