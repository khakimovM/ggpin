import { ownerAlertRecipientsLine } from '../owner-alert-recipients.log';

describe('ownerAlertRecipientsLine (D-53 boot line)', () => {
  it('names the count and the masked primary only', () => {
    const line = ownerAlertRecipientsLine('111111111,222222222');
    expect(line).toBe('owner alert recipients: 2, primary ***1111');
    expect(line).not.toContain('111111111');
    expect(line).not.toContain('222222222');
  });

  it('one id is one recipient', () => {
    expect(ownerAlertRecipientsLine('333333333')).toBe(
      'owner alert recipients: 1, primary ***3333',
    );
  });

  it('nothing configured (or unusable) reports zero and no id', () => {
    expect(ownerAlertRecipientsLine(undefined)).toBe('owner alert recipients: 0');
    expect(ownerAlertRecipientsLine('-100123')).toBe('owner alert recipients: 0');
  });
});
