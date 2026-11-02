import { Injectable } from '@nestjs/common';
import type { User } from '@repo/db';
import { localeFromTelegram, REFERRAL_CODE_LENGTH, type Locale, type Me } from '@repo/shared';
import { AppError } from '../../common/exceptions/app-error';
import { toMe } from './entities/me.mapper';
import { generateReferralCode } from './referral-code';
import { UsersRepository, type Db } from './users.repository';

export interface TelegramProfile {
  readonly telegramId: bigint;
  readonly username?: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly languageCode?: string;
  /**
   * SECURITY: only ever `user.photo_url` from validated Mini App initData. Never a Bot API
   * `getFile` URL: it embeds the bot token and must not be stored or returned to anyone.
   */
  readonly photoUrl?: string | null;
}

export interface EnsureUserOptions {
  /** Referral code from `ref_<code>` / `start_param`. Honoured only when the user is created now. */
  readonly refCode?: string;
  readonly now: Date;
}

export interface EnsureUserResult {
  readonly user: User;
  readonly created: boolean;
}

// A collision needs two of 36^8 codes to meet; three in a row means something else is wrong
// (a broken generator), so fail loudly instead of looping.
const MAX_INSERT_ATTEMPTS = 3;
const REFERRAL_CODE_SHAPE = new RegExp(`^[a-z0-9]{${REFERRAL_CODE_LENGTH}}$`);

@Injectable()
export class UsersService {
  constructor(private readonly repo: UsersRepository) {}

  /**
   * Find-or-create the user behind a verified Telegram identity. Safe under concurrency: the
   * insert is `ON CONFLICT DO NOTHING`, so of N parallel calls exactly one gets `created: true`.
   */
  ensureTelegramUser(profile: TelegramProfile, opts: EnsureUserOptions): Promise<EnsureUserResult> {
    return this.repo.transaction(async (tx) => {
      const { user, created } = await this.findOrInsert(profile, opts.now, tx);
      // Every path ends with the wallet row present (also repairs a user created without one).
      await this.repo.ensureWallet(user.id, tx);

      if (!created) {
        return { user: await this.refreshProfile(user, profile, opts.now, tx), created };
      }
      return { user: await this.applyReferral(user, opts.refCode, tx), created };
    });
  }

  /** For the auth guard: the user, or null when the id is unknown. The guard checks `isBlocked`. */
  findActiveById(id: string): Promise<User | null> {
    return this.repo.findById(id);
  }

  /** For the OTP login: the account a verified Telegram identity belongs to, or null. */
  findByTelegramId(telegramId: bigint): Promise<User | null> {
    return this.repo.findByTelegramId(telegramId);
  }

  async getMe(userId: string): Promise<Me> {
    const user = await this.repo.findById(userId);
    if (user === null) throw new AppError('NOT_FOUND');
    return toMe(user);
  }

  async updateLocale(userId: string, locale: Locale): Promise<Me> {
    const user = await this.repo.updateLocale(userId, locale);
    if (user === null) throw new AppError('NOT_FOUND');
    return toMe(user);
  }

  markBotBlocked(telegramId: bigint, at: Date): Promise<void> {
    return this.repo.setBotBlockedAt(telegramId, at);
  }

  clearBotBlocked(telegramId: bigint): Promise<void> {
    return this.repo.setBotBlockedAt(telegramId, null);
  }

  private async findOrInsert(
    profile: TelegramProfile,
    now: Date,
    tx: Db,
  ): Promise<EnsureUserResult> {
    for (let attempt = 0; attempt < MAX_INSERT_ATTEMPTS; attempt += 1) {
      const inserted = await this.repo.insertIfAbsent(
        {
          telegramId: profile.telegramId,
          referralCode: generateReferralCode(),
          username: profile.username ?? null,
          firstName: profile.firstName ?? null,
          lastName: profile.lastName ?? null,
          photoUrl: profile.photoUrl ?? null,
          // Locale is chosen once, here. Later changes only come from an explicit user choice.
          locale: localeFromTelegram(profile.languageCode),
          lastSeenAt: now,
        },
        tx,
      );
      if (inserted !== null) return { user: inserted, created: true };

      // Nothing inserted: either the telegramId exists (a concurrent winner's insert has
      // committed by now, ON CONFLICT waits for it) or only the referralCode collided.
      const existing = await this.repo.findByTelegramId(profile.telegramId, tx);
      if (existing !== null) return { user: existing, created: false };
    }
    throw new Error('Could not allocate a unique referral code');
  }

  private refreshProfile(user: User, profile: TelegramProfile, now: Date, tx: Db): Promise<User> {
    return this.repo.updateProfile(
      user.id,
      {
        username: profile.username ?? null,
        firstName: profile.firstName ?? null,
        lastName: profile.lastName ?? null,
        lastSeenAt: now,
        // Without a photo in this login (e.g. a bot /start) keep the one we already have.
        ...(profile.photoUrl ? { photoUrl: profile.photoUrl } : {}),
      },
      tx,
    );
  }

  // Binds the inviter for a brand-new user. Unknown, malformed, self or blocked inviters are
  // ignored without an error: the sign-up must not fail (or leak which codes exist).
  private async applyReferral(user: User, refCode: string | undefined, tx: Db): Promise<User> {
    if (refCode === undefined || !REFERRAL_CODE_SHAPE.test(refCode)) return user;
    const inviter = await this.repo.findByReferralCode(refCode, tx);
    if (inviter === null || inviter.id === user.id || inviter.isBlocked) return user;
    const bound = await this.repo.bindReferrer(user.id, inviter.id, tx);
    return bound ? { ...user, referredById: inviter.id } : user;
  }
}
