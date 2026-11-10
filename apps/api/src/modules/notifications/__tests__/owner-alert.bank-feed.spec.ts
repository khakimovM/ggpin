import { alertRef } from '@repo/shared';
import { AlertSourceMissingError } from '../owner-alert.renderer';
import { NOW, renderer } from './owner-alert.test-renderer';

// The bank-feed listener and security alerts (D-52), split out of owner-alert.renderer.spec.ts.
describe('OwnerAlertRenderer: bank-feed listener and security alerts', () => {
  it('listenerDown counts minutes since the heartbeat, "?" without one', async () => {
    const tenMinAgo = String(NOW.getTime() - 10 * 60_000);
    await expect(
      renderer({ heartbeat: () => Promise.resolve(tenMinAgo) }).render('listenerDown', 'x1'),
    ).resolves.toContain('10 daqiqadan');
    await expect(renderer({}).render('listenerDown', 'x1')).resolves.toContain('? daqiqadan');
  });

  it('D-52: listenerDown with the outage start in its refId needs no heartbeat', async () => {
    const ref = alertRef.listenerDown(new Date(NOW.getTime() - 7 * 60_000), NOW);
    await expect(renderer({}).render('listenerDown', ref)).resolves.toContain('7 daqiqadan');
  });

  it('D-52: listenerStopped names its reason; bankChatAnomaly its bank and reason; anything else is not renderable', async () => {
    await expect(
      renderer({}).render('listenerStopped', alertRef.listenerStopped('ACCOUNT_MISMATCH', NOW)),
    ).resolves.toContain('sabab: ACCOUNT_MISMATCH');
    const anomaly = await renderer({}).render(
      'bankChatAnomaly',
      alertRef.bankChatAnomaly('HUMO_BOT', 'OUTGOING', NOW),
    );
    expect(anomaly).toContain('HUMO boti chatida');
    expect(anomaly).toContain('(OUTGOING)');
    await expect(renderer({}).render('listenerStopped', 'x1')).rejects.toBeInstanceOf(
      AlertSourceMissingError,
    );
    await expect(
      renderer({}).render('bankChatAnomaly', 'HUMO_BOT_EDITED_41'),
    ).rejects.toBeInstanceOf(AlertSourceMissingError);
    await expect(renderer({}).render('authorizationsBaseline', '1')).resolves.toContain(
      'card:resume',
    );
  });

  it('D-52 r2 L-B: accountBound needs nothing from the database; ACCOUNT_UNBOUND is a stop reason', async () => {
    await expect(
      renderer({}).render('accountBound', alertRef.accountBound(NOW)),
    ).resolves.toContain('birinchi marta bog‘landi');
    await expect(
      renderer({}).render('listenerStopped', alertRef.listenerStopped('ACCOUNT_UNBOUND', NOW)),
    ).resolves.toContain('sabab: ACCOUNT_UNBOUND');
    // M-B: the anomaly refId is per hour; the old per-message form is not renderable.
    await expect(
      renderer({}).render('bankChatAnomaly', 'HUMO_BOT_OUTGOING_x41'),
    ).rejects.toBeInstanceOf(AlertSourceMissingError);
  });

  it('foreignChat (B2) names the bank of the source and reads nothing', async () => {
    const r = renderer({});
    const text = await r.render('foreignChat', 'UZCARD_BOT_123456');
    expect(text).toContain('XAVFSIZLIK');
    expect(text).toContain('UZCARD bot manbasiga boshqa chatdagi xabar keldi');
    await expect(r.render('foreignChat', 'cm3abc')).rejects.toBeInstanceOf(AlertSourceMissingError);
  });
});
