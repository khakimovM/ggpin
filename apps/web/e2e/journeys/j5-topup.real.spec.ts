import uz from '@repo/i18n/uz.json';
import {
  CancelTopupIntentResponseSchema,
  LedgerItemSchema,
  PAY_TOKEN_HEADER,
  PayViewSchema,
  PaymentMethodsResponseSchema,
  TopupIntentCreatedSchema,
  TopupIntentSchema,
  WalletResponseSchema,
  readPayTokenFromHash,
} from '@repo/shared';
import { expect, test, type Page } from '@playwright/test';
import {
  E2E_BOT_TOKEN,
  installFakeWebApp,
  signInitData,
  tgCalls,
  tgPressMain,
} from '../fixtures/telegram';
import { nextTelegramId, parsed, send, signInReal, type Session } from '../support/real-http';
import { setUpRealStack } from '../support/real-stack-hooks';
import { ledgerOf, reviewKindsOfCard, type TestCard } from '../support/real-topup';
import { injectBankMessage } from '../support/real-worker';

// Journey 5 (phase 7 S12-a): a payer tops up the wallet through the Mini App, against the REAL API
// and the REAL worker (own database and Redis DB, bot off, worker on BANK_FEED_MODE=fake and
// FULFILLMENT_DRY_RUN=true; every process runs under a loopback guard, so nothing leaves the
// machine). Telegram is the fake from fixtures/telegram.ts; the bank notification is the worker's
// own `bank-feed:inject` tool. The card is synthetic and RETIRED at the end.

test.describe.configure({ mode: 'serial' });

const stack = setUpRealStack();
const theCard = (): TestCard => stack.card();

// Unique per run and never a real person's id (see nextTelegramId).
const newTelegramId = nextTelegramId;

/**
 * D-51: the middle groups of the card number are not in the page, in any form. A page that showed
 * two neighbouring groups ("1234 5678", "1234•5678", "1234-5678") would match.
 */
function cardLeak(pan: string): RegExp {
  const [, second, third] = pan.match(/\d{4}/g) ?? [];
  return new RegExp(`${second ?? '-'}\\D{0,3}${third ?? '-'}`);
}

/** "50347" so'm as a pattern that accepts the grouping the page uses ("50 347", no-break spaces). */
function somPattern(tiyin: string): RegExp {
  const digits = (BigInt(tiyin) / 100n).toString();
  return new RegExp(digits.replace(/(\d)(?=(\d{3})+$)/g, '$1\\s?'));
}
const somDigits = (tiyin: string) => (BigInt(tiyin) / 100n).toString();

async function openLinks(page: Page): Promise<string[]> {
  return (await tgCalls(page))
    .filter(([name]) => name === 'openLink')
    .map(([, url]) => String(url));
}

async function loginAs(page: Page, telegramId: number) {
  const initData = signInitData(
    { user: { id: telegramId, first_name: `Payer${telegramId}`, language_code: 'uz' } },
    E2E_BOT_TOKEN,
  );
  await installFakeWebApp(page, { initData, languageCode: 'uz' });
}

const tgTopup = uz.tg.topup;

test('a payer tops up: request, pay page, bank message, balance, success', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(240_000);
  const telegramId = newTelegramId();
  await loginAs(page, telegramId);

  // ---- 1. /tg -> top-up -> amount -> the request is made -------------------------------------
  await page.goto('/tg/topup');
  const field = page.getByRole('textbox', { name: uz.store.topup.amount.label });
  // The limits and the bank availability come from the server; the worker's listener is alive.
  await expect(field).toBeVisible({ timeout: 45_000 });
  await page.getByRole('button', { name: '50 000' }).click();
  await page.getByRole('radio', { name: uz.store.topup.cardType.humo }).click();
  await tgPressMain(page);

  await expect(page).toHaveURL(/\/tg\/topup\/[\w-]+$/, { timeout: 30_000 });
  const intentId = new URL(page.url()).pathname.split('/').pop() ?? '';
  const [link, ...more] = await openLinks(page);
  expect(more).toEqual([]);

  // What the server made, read with the same session the Mini App has (never trusted from the UI).
  const payer: Session = await signInReal(request, telegramId);
  const made = await send(request, 'GET', `/payments/intents/${intentId}`, { session: payer });
  const intent = parsed(made, TopupIntentSchema).data;
  expect(intent).toMatchObject({ status: 'PENDING', baseAmountTiyin: '5000000' });
  expect(intent.card?.number).toBe(theCard().pan);
  const pay = intent.payAmountTiyin;
  expect(BigInt(pay) - 5_000_000n).toBeGreaterThanOrEqual(100n); // the unique 1..999 so'm extra

  // The Mini App shows the waiting screen with the exact amount, and NEVER the card.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(tgTopup.waiting.title);
  await expect(page.locator('main')).toContainText(somPattern(pay));
  expect(await page.content()).not.toMatch(cardLeak(theCard().pan));
  await expect(page.locator('body')).not.toContainText(theCard().pan.slice(4, 12));

  // ---- 2. the pay page, in a second context (the browser the Mini App hands the link to) ------
  const url = new URL(link ?? '');
  expect(url.origin).toBe('http://localhost:3100');
  expect(url.pathname).toBe(`/pay/${intentId}`);
  expect(url.search).toBe('?locale=uz');
  expect(readPayTokenFromHash(url.hash)).not.toBeNull();

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const payPage = await context.newPage();
    await payPage.goto(url.href);
    const amount = payPage.getByTestId('pay-amount');
    await expect(amount).toBeVisible({ timeout: 30_000 });
    // D-50: the page took the token from the address and took it out of it.
    await expect(payPage).not.toHaveURL(/#t=/);
    // The same exact amount (the digits), its last three digits marked as the tail.
    expect(((await amount.textContent()) ?? '').replace(/\D/g, '')).toBe(somDigits(pay));
    await expect(payPage.getByTestId('pay-amount-tail')).toHaveText(somDigits(pay).slice(-3));
    // D-51: the card starts hidden: the middle digits are not in the page at all.
    const groups = theCard().pan.match(/\d{4}/g) ?? [];
    const number = payPage.getByTestId('pay-card-number');
    await expect(number).toHaveAccessibleName(
      uz.pay.cardMasked
        .replace('{first}', groups[0] ?? '')
        .replace('{last}', groups[groups.length - 1] ?? ''),
    );
    const html = await number.innerHTML();
    for (const group of groups.slice(1, -1)) expect(html).not.toContain(group);
    expect(await payPage.content()).not.toMatch(cardLeak(theCard().pan));
    await payPage.getByRole('button', { name: uz.pay.showCard }).click();
    await expect(number).toHaveAccessibleName(groups.join(' '));
    await expect(payPage.getByTestId('pay-card-holder')).toHaveText('WEB E.');
    await expect(payPage.getByTestId('pay-owner')).toContainText(
      `P***${String(telegramId).slice(-1)}`,
    );

    // ---- 3. the bank message arrives; the worker credits the wallet -----------------------------
    const injected = await injectBankMessage({
      bank: 'HUMO',
      payAmountTiyin: pay,
      last4: theCard().last4,
    });
    expect(injected).toMatch(/^stored bankMessageId=/);

    // ---- 4. both screens turn to success (the ordinary polling, no reload) ----------------------
    await expect(payPage.getByText(uz.pay.credited.title)).toBeVisible({ timeout: 90_000 });
    await expect(payPage.getByTestId('pay-card-number')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(tgTopup.credited.title, {
      timeout: 90_000,
    });
  } finally {
    await context.close();
  }

  // The credited screen: what the server credited, and the balance (from /me/wallet).
  await expect(page.locator('main')).toContainText(somPattern(pay));
  await expect(page.locator('main')).toContainText(uz.wallet.card.balance);

  // ---- 5. the wallet: API, database and the screens agree --------------------------------------
  const wallet = parsed(
    await send(request, 'GET', '/me/wallet', { session: payer }),
    WalletResponseSchema,
  ).data;
  expect(wallet.balanceTiyin).toBe(pay); // a new account: exactly what the bank message carried

  const ledger = parsed(
    await send(request, 'GET', '/me/ledger', { session: payer }),
    LedgerItemSchema.array(),
  );
  expect(ledger.data).toHaveLength(1);
  expect(ledger.data[0]).toMatchObject({ kind: 'TOPUP', amountTiyin: pay, orderId: null });
  expect(ledger.data[0]?.paymentId).not.toBeNull();
  expect(await ledgerOf(telegramId)).toEqual([
    { kind: 'TOPUP', amountTiyin: pay, refType: 'PAYMENT' },
  ]);
  expect(await reviewKindsOfCard(theCard())).toEqual([]); // credited by itself, nothing for the owner

  const done = parsed(
    await send(request, 'GET', `/payments/intents/${intentId}`, { session: payer }),
    TopupIntentSchema,
  ).data;
  expect(done).toMatchObject({ status: 'PAID', card: null, creditedTiyin: pay });
  expect(done.paidAt).not.toBeNull();

  // The pay page's token still reads (until it expires) and now says PAID with no card.
  const view = parsed(
    await send(request, 'GET', `/payments/pay/${intentId}`, {
      headers: { [PAY_TOKEN_HEADER]: readPayTokenFromHash(url.hash) ?? '' },
    }),
    PayViewSchema,
  ).data;
  expect(view).toMatchObject({ status: 'PAID', card: null });

  // Home: the wallet card shows the new balance, reached by the app's own navigation.
  await page.getByRole('button', { name: tgTopup.credited.home }).click();
  await expect(page).toHaveURL(/\/tg$/);
  await expect(page.getByTestId('wallet-balance')).toContainText(somPattern(pay), {
    timeout: 30_000,
  });

  // History, finance tab: the top-up row with the amount received.
  await page.getByRole('link', { name: uz.account.nav.history }).click();
  await page.getByRole('tab', { name: uz.account.history.tabs.finance }).click();
  const row = page.getByText(uz.account.history.ledger.kind.TOPUP);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('main')).toContainText(somPattern(pay));
});

// The failure path: money that arrives for a request the payer CANCELLED is never credited by
// itself. It waits for the owner as a review (CANCELLED_LATE); the wallet does not move.
test('money for a cancelled request is not credited: the owner gets a review, the balance stays', async ({
  request,
}) => {
  test.setTimeout(180_000);
  const payer = await signInReal(request, newTelegramId());
  // The worker's listener has to be alive for a request to be handed out.
  await expect
    .poll(
      async () => {
        const response = await send(request, 'GET', '/payments/methods', { session: payer });
        return parsed(response, PaymentMethodsResponseSchema).data[0]?.available;
      },
      { timeout: 45_000 },
    )
    .toBe(true);
  parsed(
    await send(request, 'POST', '/payments/intents', {
      session: payer,
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: { provider: 'P2P_CARD', amountTiyin: '5000000', purpose: 'TOPUP' },
    }),
    TopupIntentCreatedSchema,
    201,
  );
  const [open] = parsed(
    await send(request, 'GET', '/payments/intents?status=PENDING', { session: payer }),
    TopupIntentSchema.array(),
  ).data;
  if (open === undefined) throw new Error('the request that was just made is not listed');
  expect(
    parsed(
      await send(request, 'POST', `/payments/intents/${open.intentId}/cancel`, {
        session: payer,
        body: {},
      }),
      CancelTopupIntentResponseSchema,
    ).data.status,
  ).toBe('CANCELLED');

  // The payer sends the money all the same (to the card the request had).
  await injectBankMessage({
    bank: 'HUMO',
    payAmountTiyin: open.payAmountTiyin,
    last4: theCard().last4,
  });
  await expect
    .poll(async () => reviewKindsOfCard(theCard()), { timeout: 90_000, intervals: [1000] })
    .toContain('CANCELLED_LATE');

  const wallet = parsed(
    await send(request, 'GET', '/me/wallet', { session: payer }),
    WalletResponseSchema,
  ).data;
  expect(wallet.balanceTiyin).toBe('0');
  expect(await ledgerOf(payer.telegramId)).toEqual([]);
  const after = parsed(
    await send(request, 'GET', `/payments/intents/${open.intentId}`, { session: payer }),
    TopupIntentSchema,
  ).data;
  expect(after).toMatchObject({ status: 'CANCELLED', card: null, creditedTiyin: null });
});
