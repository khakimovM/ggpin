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
  /** Nonces waiting for a phone contact, by Telegram id (the Redis store's stand-in). */
  readonly pendingContacts: Map<bigint, string>;
  /** Arguments of every OtpLoginService call, in order. */
  readonly loginCalls: { method: string; nonce: string }[];
  /** Arguments of every releaseCode call. */
  readonly releaseCalls: { nonce: string; telegramId: bigint; code: string }[];
  /** Family ids passed to endSessionFromBot, in order. */
  readonly endedFamilies: string[];
  send(update: Update): Promise<void>;
  /** Calls made to the Bot API, without the boot-independent noise: payloads only. */
  payloads(): unknown[];
}

export interface HarnessOptions {
  readonly config?: Partial<BotConfig>;
  readonly users?: readonly User[];
  readonly login?: Partial<BotDeps['login']>;
  readonly sessions?: Partial<BotDeps['sessions']>;
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
    setPhone: (userId, phone) => {
      const found = [...store.values()].find((u) => u.id === userId);
      if (found === undefined || found.phone !== null) return Promise.resolve(false);
      store.set(found.telegramId, { ...found, phone });
      return Promise.resolve(true);
    },
    clearBotBlocked: (telegramId) => {
      const found = store.get(telegramId);
      if (found !== undefined) store.set(telegramId, { ...found, botBlockedAt: null });
      return Promise.resolve();
    },
  };

  const pendingContacts = new Map<bigint, string>();
  const loginCalls: BotHarness['loginCalls'] = [];
  const releaseCalls: BotHarness['releaseCalls'] = [];
  const endedFamilies: string[] = [];
  const login: BotDeps['login'] = {
    issueCode: (input) => {
      loginCalls.push({ method: 'issueCode', nonce: input.nonce });
      return options.login?.issueCode?.(input) ?? Promise.resolve({ ok: true, code: '482913' });
    },
    deny: (input) => {
      loginCalls.push({ method: 'deny', nonce: input.nonce });
      return options.login?.deny?.(input) ?? Promise.resolve('denied' as const);
    },
    releaseCode: (input) => {
      releaseCalls.push({ nonce: input.nonce, telegramId: input.telegramId, code: input.code });
      return options.login?.releaseCode?.(input) ?? Promise.resolve(true);
    },
    status: (nonce, now) => {
      loginCalls.push({ method: 'status', nonce });
      return options.login?.status?.(nonce, now) ?? Promise.resolve({ status: 'PENDING' });
    },
  };
  const sessions: BotDeps['sessions'] = {
    endSessionFromBot: (input) => {
      endedFamilies.push(input.familyId);
      return options.sessions?.endSessionFromBot?.(input) ?? Promise.resolve(true);
    },
  };
  const loginContact: BotDeps['loginContact'] = {
    remember: (telegramId, nonce) => {
      pendingContacts.set(telegramId, nonce);
      return Promise.resolve();
    },
    take: (telegramId) => {
      const nonce = pendingContacts.get(telegramId) ?? null;
      pendingContacts.delete(telegramId);
      return Promise.resolve(nonce);
    },
  };

  const setup = new BotSetupService(fake.bot, config);
  installHandlers(fake.bot, {
    users,
    login,
    sessions,
    loginContact,
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
    pendingContacts,
    loginCalls,
    releaseCalls,
    endedFamilies,
    send: (update) => fake.bot.handleUpdate(update),
    payloads: () => fake.calls.map((c) => ({ [c.method]: c.payload })),
  };
}
