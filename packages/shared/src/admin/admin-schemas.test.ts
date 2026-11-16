import { describe, expect, it } from 'vitest';
import { FX_PAIRS } from '../money';
import { QUEUES } from '../queues';
import * as a from './index';

const REASON = 'Mijoz pulni qaytarishni so‘radi';
const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe('roles and session', () => {
  it('names the admin cookie per environment, never like a user cookie', () => {
    expect(a.adminSessionCookieName('production')).toBe('__Host-adm_session');
    expect(a.adminSessionCookieName('development')).toBe('adm_session');
    expect(a.adminSessionCookieName('test')).toBe('adm_session');
    expect(['access_token', 'refresh_token']).not.toContain(a.ADMIN_SESSION_COOKIE_NAME);
  });

  it('keeps 8 h absolute and 1 h idle, and lets the panel give only OPERATOR or SUPPORT', () => {
    expect(a.ADMIN_SESSION_TTL_SEC).toBe(8 * 3600);
    expect(a.ADMIN_SESSION_IDLE_SEC).toBe(3600);
    expect(ok(a.PanelAssignableRoleSchema, 'OWNER')).toBe(false);
    expect(a.ADMIN_ROLES).toEqual(['OWNER', 'OPERATOR', 'SUPPORT']);
  });
});

describe('audit actions', () => {
  it('reuse the owner CLI action names byte for byte', () => {
    expect(a.ADMIN_AUDIT_ACTIONS).toEqual(
      expect.arrayContaining([
        'WALLET_ADJUST',
        'PAYMENT_REVERSE',
        'USER_UNFREEZE',
        'REVIEW_CREDIT',
        'CARD_PAUSE',
        'CARD_RESUME',
        'CARD_LIMIT',
        'CARD_RETIRE',
        'CARD_RETIRE_EMERGENCY',
        'ORDER_RETRY',
        'ORDER_REVIEW_RESOLVE',
        'FX_SET',
        'ADMIN_LOGIN',
        'ADMIN_LOGOUT',
        'ORDER_NOTE',
        'USER_NOTE',
        'AUDIT_EXPORT',
      ]),
    );
    expect(new Set(a.ADMIN_AUDIT_ACTIONS).size).toBe(a.ADMIN_AUDIT_ACTIONS.length);
    for (const name of a.NON_PANEL_AUDIT_ACTIONS) expect(a.ADMIN_AUDIT_ACTIONS).not.toContain(name);
  });

  it('filters by any upper-case action name', () => {
    expect(ok(a.AuditActionFilterSchema, 'CARD_ADD')).toBe(true);
    expect(ok(a.AuditActionFilterSchema, 'card_add')).toBe(false);
  });
});

describe('AdminReasonSchema', () => {
  it('takes 10..500 characters after trimming', () => {
    expect(ok(a.AdminReasonSchema, 'a'.repeat(9))).toBe(false);
    expect(ok(a.AdminReasonSchema, 'a'.repeat(10))).toBe(true);
    expect(ok(a.AdminReasonSchema, 'a'.repeat(500))).toBe(true);
    expect(ok(a.AdminReasonSchema, 'a'.repeat(501))).toBe(false);
    expect(ok(a.AdminReasonSchema, `   ${'a'.repeat(9)}   `)).toBe(false);
    expect(a.AdminReasonSchema.parse(`  ${REASON}  `)).toBe(REASON);
  });

  it('refuses invisible characters and text without a letter or digit', () => {
    expect(ok(a.AdminReasonSchema, `${REASON}‮`)).toBe(false);
    expect(ok(a.AdminReasonSchema, `${REASON}\nsecond line`)).toBe(false);
    expect(ok(a.AdminReasonSchema, '.'.repeat(12))).toBe(false);
  });
});

describe('step-up fields', () => {
  const otp = { challengeId: 'a'.repeat(32), code: '123456' };
  it('takes a 32-hex challenge and a 6-digit code only', () => {
    expect(ok(a.AdminOtpAnswerSchema, otp)).toBe(true);
    expect(ok(a.AdminOtpAnswerSchema, { ...otp, challengeId: 'A'.repeat(32) })).toBe(false);
    expect(ok(a.AdminOtpAnswerSchema, { ...otp, code: '12345' })).toBe(false);
    expect(ok(a.AdminConfirmationSchema, { confirmAmountTiyin: '100', otp })).toBe(true);
  });

  it('requires the code on every admin-management write', () => {
    const body = { telegramId: '123456789', name: 'Ali', role: 'SUPPORT', reason: REASON };
    expect(ok(a.AdminCreateBodySchema, body)).toBe(false);
    expect(ok(a.AdminCreateBodySchema, { ...body, otp })).toBe(true);
    expect(ok(a.AdminCreateBodySchema, { ...body, otp, role: 'OWNER' })).toBe(false);
    expect(ok(a.AdminUpdateBodySchema, { reason: REASON, otp })).toBe(false);
    expect(ok(a.AdminUpdateBodySchema, { reason: REASON, otp, isActive: false })).toBe(true);
  });

  it('binds a confirmation to one known action with its own fields', () => {
    const cancel = { action: 'orders.cancel', targetId: 'ord_1', amountTiyin: '550000' };
    expect(ok(a.AdminConfirmationBodySchema, cancel)).toBe(true);
    expect(ok(a.AdminConfirmationBodySchema, { ...cancel, action: 'orders.note' })).toBe(false);
    expect(ok(a.AdminConfirmationBodySchema, { ...cancel, flags: 'override' })).toBe(false);
    const credit = { action: 'payments.reviewCredit', targetId: 'rev_1', amountTiyin: '100' };
    expect(ok(a.AdminConfirmationBodySchema, { ...credit, userId: 'u_1' })).toBe(true);
    expect(ok(a.AdminConfirmationBodySchema, { ...credit, userId: 'u_1', intentId: 'i_1' })).toBe(
      false,
    );
    expect(
      ok(a.AdminConfirmationBodySchema, { action: 'fx.set', pair: 'USDT_UZS', rate: '0' }),
    ).toBe(false);
    expect(
      ok(a.AdminConfirmationBodySchema, { action: 'fx.set', pair: 'USDT_UZS', rate: '12650.5' }),
    ).toBe(true);
  });
});

describe('query rules', () => {
  it('orders the date range and the dashboard period', () => {
    const from = '2026-11-01T00:00:00.000Z';
    const to = '2026-11-02T00:00:00.000Z';
    expect(ok(a.AdminUserListQuerySchema, { from, to })).toBe(true);
    expect(ok(a.AdminUserListQuerySchema, { from: to, to: from })).toBe(false);
    expect(ok(a.AdminUserListQuerySchema, { from })).toBe(true);
    expect(ok(a.AdminDashboardQuerySchema, {})).toBe(true);
    expect(ok(a.AdminDashboardQuerySchema, { period: 'range', from, to })).toBe(true);
    expect(ok(a.AdminDashboardQuerySchema, { period: 'range', from })).toBe(false);
    expect(ok(a.AdminDashboardQuerySchema, { period: 'week', from, to })).toBe(false);
    const far = '2028-01-01T00:00:00.000Z';
    expect(ok(a.AdminDashboardQuerySchema, { period: 'range', from, to: far })).toBe(false);
  });

  it('splits the order status list and checks the amount range without throwing', () => {
    expect(a.AdminOrderListQuerySchema.parse({ status: 'PAID,QUEUED' }).status).toEqual([
      'PAID',
      'QUEUED',
    ]);
    expect(ok(a.AdminOrderListQuerySchema, { status: 'PAID,NOPE' })).toBe(false);
    expect(ok(a.AdminOrderListQuerySchema, { minTiyin: '5', maxTiyin: '4' })).toBe(false);
    expect(ok(a.AdminOrderListQuerySchema, { minTiyin: '4', maxTiyin: '5' })).toBe(true);
    expect(ok(a.AdminOrderListQuerySchema, { minTiyin: '1.5', maxTiyin: '5' })).toBe(false);
    expect(ok(a.AdminOrderListQuerySchema, { minTiyin: '5', maxTiyin: 'x' })).toBe(false);
  });

  it('needs exactly one credit target and one price-preview subject', () => {
    expect(ok(a.AdminCreditPreviewQuerySchema, { intentId: 'i_1' })).toBe(true);
    expect(ok(a.AdminCreditPreviewQuerySchema, {})).toBe(false);
    expect(ok(a.AdminPricePreviewQuerySchema, { skuId: 's_1' })).toBe(true);
    expect(ok(a.AdminPricePreviewQuerySchema, { quantity: '50', markupBps: '1500' })).toBe(true);
    expect(ok(a.AdminPricePreviewQuerySchema, { skuId: 's_1', quantity: '50' })).toBe(false);
    expect(ok(a.AdminReviewCreditBodySchema, { reason: REASON })).toBe(false);
    expect(ok(a.AdminReviewCreditBodySchema, { reason: REASON, userId: 'u_1' })).toBe(true);
  });

  it('retries only notify and tg-outbox jobs', () => {
    expect(a.ADMIN_RETRYABLE_QUEUES).toEqual([QUEUES.NOTIFY, QUEUES.TG_OUTBOX]);
    expect(ok(a.AdminQueueRetryParamsSchema, { name: 'fulfill-order', id: '1' })).toBe(false);
  });
});

describe('catalog and settings writes', () => {
  it('refuses an empty change and keeps markup within 0..10 000 bps', () => {
    expect(ok(a.AdminProductUpdateBodySchema, {})).toBe(false);
    expect(ok(a.AdminProductUpdateBodySchema, { reason: REASON })).toBe(false);
    expect(ok(a.AdminProductUpdateBodySchema, { isActive: false })).toBe(true);
    expect(ok(a.AdminCategoryUpdateBodySchema, { sort: 2 })).toBe(true);
    expect(ok(a.AdminRouteUpdateBodySchema, { isEnabled: false })).toBe(true);
    expect(ok(a.AdminSkuUpdateBodySchema, { markupBps: 10_000 })).toBe(true);
    expect(ok(a.AdminSkuUpdateBodySchema, { markupBps: 10_001 })).toBe(false);
    expect(ok(a.AdminSkuUpdateBodySchema, { markupBps: -1 })).toBe(false);
  });

  it('takes images only from /assets/ and every product once in a reorder', () => {
    expect(ok(a.AssetPathSchema, '/assets/products/stars.webp')).toBe(true);
    expect(ok(a.AssetPathSchema, '/assets/../secret.png')).toBe(false);
    expect(ok(a.AssetPathSchema, '/assets//x.png')).toBe(false);
    expect(ok(a.AssetPathSchema, 'https://evil.example/x.png')).toBe(false);
    expect(ok(a.AdminProductReorderBodySchema, { productIds: ['p_1', 'p_2'] })).toBe(true);
    expect(ok(a.AdminProductReorderBodySchema, { productIds: ['p_1', 'p_1'] })).toBe(false);
  });

  it('sets a manual rate only for the two manual pairs, positive', () => {
    const body = { pair: 'USDT_UZS', rate: '12650', reason: REASON };
    expect(ok(a.AdminFxSetBodySchema, body)).toBe(true);
    expect(ok(a.AdminFxSetBodySchema, { ...body, pair: 'TON_UZS' })).toBe(false);
    expect(ok(a.AdminFxSetBodySchema, { ...body, rate: '0.000' })).toBe(false);
    expect([...a.ADMIN_FX_PAIRS].sort()).toEqual(Object.keys(FX_PAIRS).sort());
  });
});
