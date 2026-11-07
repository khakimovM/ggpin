import uz from '@repo/i18n/uz.json';
import { CSRF_HEADER } from '@repo/shared';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E_BOT_TOKEN, installFakeWebApp, signInitData } from '../fixtures/telegram';
import { API_BASE, dbValue, startRealApi, type RunningApi } from '../support/real-api';

// Journey 4 (phase 7 S4): a referral link opens the Mini App. The page signs in against the REAL
// API (own database and Redis DB, bot off, synthetic token: see support/real-api.ts); Telegram is
// the fake from fixtures/telegram.ts. The binding is read back from the database.

test.describe.configure({ mode: 'serial' });

let api: RunningApi;
test.beforeAll(async () => {
  api = await startRealApi();
});
test.afterAll(async () => {
  await api.stop();
});

// Unique per run: the database keeps users between runs, and a Telegram id is one account.
const runId = Date.now() % 1_000_000_000;
let nextId = 700_000_000 + runId;
const newTelegramId = () => nextId++;

interface Account {
  telegramId: number;
  id: string;
  referralCode: string;
}

const referredBy = (telegramId: number) =>
  dbValue<string>(
    `SELECT r."telegramId"::text FROM "User" u JOIN "User" r ON r.id = u."referredById" WHERE u."telegramId" = $1`,
    [telegramId],
  );

const referredByIdOf = (telegramId: number) =>
  dbValue<string | null>(`SELECT "referredById" FROM "User" WHERE "telegramId" = $1`, [telegramId]);

/** A Mini App sign-in made straight against the API (what the inviter did earlier). */
async function signInDirect(request: APIRequestContext, telegramId: number): Promise<Account> {
  const initData = signInitData(
    { user: { id: telegramId, first_name: `Inviter${telegramId}`, language_code: 'uz' } },
    E2E_BOT_TOKEN,
  );
  const response = await request.post(`${API_BASE}/auth/telegram/webapp`, {
    // The API's CSRF check wants the header and an allowed Origin (a browser adds the latter).
    headers: { [CSRF_HEADER]: '1', origin: 'http://localhost:3100' },
    data: { initData },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    data: { user: { id: string; referralCode: string } };
  };
  return { ...body.data.user, telegramId };
}

/** Opens the Mini App in a browser as `telegramId`, launched with `startParam`. */
async function openMiniApp(
  page: Page,
  telegramId: number,
  startParam: string | undefined,
  overrides: { token?: string; authDate?: number } = {},
) {
  const initData = signInitData(
    {
      user: { id: telegramId, first_name: `User${telegramId}`, language_code: 'uz' },
      ...(startParam === undefined ? {} : { start_param: startParam }),
      ...(overrides.authDate === undefined ? {} : { auth_date: overrides.authDate }),
    },
    overrides.token ?? E2E_BOT_TOKEN,
  );
  await installFakeWebApp(page, { initData });
  await page.goto('/tg');
}

test('a referral link binds the new user to the inviter, once', async ({ page, request }) => {
  const inviter = await signInDirect(request, newTelegramId());
  expect(await referredByIdOf(inviter.telegramId)).toBeNull();

  const newcomer = newTelegramId();
  await openMiniApp(page, newcomer, `ref_${inviter.referralCode}`);
  // The page is really signed in: the home screen greets the profile the API created.
  await expect(page.getByRole('heading', { level: 1, name: `User${newcomer}` })).toBeVisible();
  expect(page.url()).toMatch(/\/tg$/);

  expect(await referredBy(newcomer)).toBe(String(inviter.telegramId));
  expect(await referredByIdOf(newcomer)).toBe(inviter.id);
});

test('without a start parameter nobody is bound', async ({ page }) => {
  const user = newTelegramId();
  await openMiniApp(page, user, undefined);
  await expect(page.getByRole('heading', { level: 1, name: `User${user}` })).toBeVisible();
  expect(await referredByIdOf(user)).toBeNull();
});

test('a link to a code that does not exist binds nobody and still lets the user in', async ({
  page,
}) => {
  const user = newTelegramId();
  await openMiniApp(page, user, 'ref_zzzzzzzz');
  await expect(page.getByRole('heading', { level: 1, name: `User${user}` })).toBeVisible();
  expect(await referredByIdOf(user)).toBeNull();
});

// What this proves is that an EXISTING account opening its own link stays unbound. Self-referral
// itself (the service ignores a user's own code, and the DB CHECK referredById <> id rejects it) is
// proven in the API e2e: apps/api/src/modules/users/__tests__/users-referral.e2e-spec.ts.
test('an existing account that opens its own link stays unbound', async ({ page, request }) => {
  const account = await signInDirect(request, newTelegramId());
  await openMiniApp(page, account.telegramId, `ref_${account.referralCode}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await referredByIdOf(account.telegramId)).toBeNull();
});

test('a link used by an existing account does not rebind it', async ({ page, request }) => {
  const first = await signInDirect(request, newTelegramId());
  const second = await signInDirect(request, newTelegramId());
  // `second` already exists, so a link replayed on it is only a candidate that is dropped.
  await openMiniApp(page, second.telegramId, `ref_${first.referralCode}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await referredByIdOf(second.telegramId)).toBeNull();
});

test('launch data signed with another bot token is refused, and nothing is created', async ({
  page,
}) => {
  const user = newTelegramId();
  await openMiniApp(page, user, undefined, {
    token: '111111111:forgedTokenForTheNegativeTest0123456789',
  });
  await expect(page.getByRole('heading', { name: uz.tg.gate.reopen.title })).toBeVisible();
  expect(page.url()).toMatch(/\/tg$/);
  expect(await dbValue(`SELECT id FROM "User" WHERE "telegramId" = $1`, [user])).toBeNull();
});

test('launch data older than 24 hours is refused as expired', async ({ page }) => {
  const user = newTelegramId();
  const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 24 * 3600;
  await openMiniApp(page, user, undefined, { authDate: twoDaysAgo });
  await expect(page.getByRole('heading', { name: uz.tg.gate.reopen.title })).toBeVisible();
  expect(await dbValue(`SELECT id FROM "User" WHERE "telegramId" = $1`, [user])).toBeNull();
});
