import type { User } from '@repo/db';
import { localeFromTelegram, type Locale } from '@repo/shared';
import type { Update } from 'grammy/types';
import type { Clock } from '../../../common/clock/clock';
import type { BotDeps, BotConfig } from '../bot-deps';
import { BotSetupService } from '../bot-setup.service';
import { installHandlers } from '../install-handlers';
import { createFakeTelegram, type FakeTelegram } from './fake-telegram-api';

export const NOW = new Date('2026-06-01T12:00:00.000Z');
const CLOCK: Clock = { now: () => NOW };

export interface BotHarness extends FakeTelegram {
  readonly store: Map<bigint, User>;
  readonly logs: { warn: string[]; error: string[] };
  readonly refCodes: (string | undefined)[];
  send(update: Update): Promise<void>;
  /** Calls made to the Bot API, without the boot-independent noise: payloads only. */
  payloads(): unknown[];
}

export interface HarnessOptions {
  readonly config?: Partial<BotConfig>;
  readonly users?: readonly User[];
}

export function makeUser(telegramId: bigint, overrides: Partial<User> = {}): User {
  return {
    id: `user-${telegramId}`,
    telegramId,
    username: null,
    firstName: 'Ann',
    lastName: null,
    photoUrl: null,
    phone: null,
    locale: 'uz',
    referralCode: 'abcd1234',
    referredById: null,
    isBlocked: false,
    purchaseFrozen: false,
    botBlockedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
    ...overrides,
  };
}

// The real handler stack on a fake Bot API, with an in-memory stand-in for UsersService.
export function createHarness(options: HarnessOptions = {}): BotHarness {
  const fake = createFakeTelegram();
  const store = new Map<bigint, User>((options.users ?? []).map((u) => [u.telegramId, u]));
  const logs = { warn: [] as string[], error: [] as string[] };
  const refCodes: (string | undefined)[] = [];
  const config: BotConfig = {
    TELEGRAM_BOT_USERNAME: 'ggpin_test_bot',
    NODE_ENV: 'test',
    MINI_APP_URL: 'https://app.example.test/tg',
    ...options.config,
  };

  const users: BotDeps['users'] = {
    ensureTelegramUser: (profile, opts) => {
      refCodes.push(opts.refCode);
      const existing = store.get(profile.telegramId);
      if (existing !== undefined) return Promise.resolve({ user: existing, created: false });
      const user = makeUser(profile.telegramId, {
        firstName: profile.firstName ?? null,
        locale: localeFromTelegram(profile.languageCode),
      });
      store.set(profile.telegramId, user);
      return Promise.resolve({ user, created: true });
    },
    updateLocale: (userId, locale: Locale) => {
      const found = [...store.values()].find((u) => u.id === userId);
      if (found === undefined) return Promise.reject(new Error('unknown user'));
      store.set(found.telegramId, { ...found, locale });
      return Promise.resolve({ locale } as Awaited<ReturnType<BotDeps['users']['updateLocale']>>);
    },
    markBotBlocked: (telegramId, at) => {
      const found = store.get(telegramId);
      if (found !== undefined) store.set(telegramId, { ...found, botBlockedAt: at });
      return Promise.resolve();
    },
    clearBotBlocked: (telegramId) => {
      const found = store.get(telegramId);
      if (found !== undefined) store.set(telegramId, { ...found, botBlockedAt: null });
      return Promise.resolve();
    },
  };

  const setup = new BotSetupService(fake.bot, config);
  installHandlers(fake.bot, {
    users,
    clock: CLOCK,
    config,
    menu: setup,
    log: { warn: (m) => logs.warn.push(m), error: (m) => logs.error.push(m) },
  });

  return {
    ...fake,
    store,
    logs,
    refCodes,
    send: (update) => fake.bot.handleUpdate(update),
    payloads: () => fake.calls.map((c) => ({ [c.method]: c.payload })),
  };
}
