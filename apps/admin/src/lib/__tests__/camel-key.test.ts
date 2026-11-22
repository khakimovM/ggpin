import { DASHBOARD_ALERT_KINDS, REVIEW_KINDS } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import catalog from '../../../../../packages/i18n/admin.uz.json';
import { camelKey } from '../camel-key';

describe('enum → catalog key', () => {
  it('turns UPPER_SNAKE into camelCase', () => {
    expect(camelKey('ORDERS_NEEDS_REVIEW')).toBe('ordersNeedsReview');
    expect(camelKey('ACTIVE')).toBe('active');
    expect(camelKey('TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN')).toBe('topupNewAccountDailyMaxTiyin');
  });

  it('every alert and review kind from the API has its Uzbek text', () => {
    const alerts = catalog.admin.dashboard.alerts;
    for (const kind of DASHBOARD_ALERT_KINDS) {
      expect(Object.keys(alerts.kind)).toContain(camelKey(kind));
      expect(Object.keys(alerts.cta)).toContain(camelKey(kind));
    }
    for (const kind of REVIEW_KINDS) {
      expect(Object.keys(catalog.admin.payments.reviewKind)).toContain(camelKey(kind));
    }
  });
});
