import {
  ACTOR_ID,
  NOW,
  REASON,
  SESSION_ID,
  TARGET_ID,
  WHO,
  body,
  row,
  setup,
} from './admin-panel-accounts.fake';

// Phase 9 S9a: the panel's admin management in isolation — the lock order (acting admin FOR SHARE
// -> target -> sessions), the OWNER rule, what ends sessions and codes, and the alert only after a
// committed write. The real locks and races are in admin-accounts-write(-races).e2e-spec.ts.

describe('AdminPanelAccountsService', () => {
  it('deactivate: code, actor FOR SHARE, target FOR UPDATE, sessions and codes in the tx, then the alert', async () => {
    const s = setup();
    const res = await s.service.update(s.actor, TARGET_ID, body({ isActive: false }));
    expect(s.calls).toEqual([
      'otp',
      'actor FOR SHARE',
      'target UPDATE',
      'update',
      'sessions lock',
      'sessions',
      'codes',
      'audit',
      'alert',
    ]);
    expect(res).toMatchObject({ applied: true, auditId: s.actor.request.auditId });
    expect(s.audits[0]).toMatchObject({ action: 'ADMIN_UPDATE', before: { isActive: true } });
    expect(s.audits[0]?.before).toEqual({ isActive: true });
    expect(s.audits[0]?.after).toEqual({
      isActive: false,
      revokedSessions: 2,
      expiredLoginCodes: 1,
      ...WHO,
    });
  });

  it('an OWNER row is refused with OWNER_ROW before any code check or lock (SA S9a-I2)', async () => {
    const s = setup(row({ role: 'OWNER' }));
    await expect(s.service.update(s.actor, TARGET_ID, body({ name: 'X' }))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'id', reason: 'OWNER_ROW' },
    });
    expect(s.calls).toEqual([]);
    expect(s.alerts.adminAction).not.toHaveBeenCalled();
  });

  it('an admin made OWNER (CLI) between the early read and the lock: OWNER_ROW under the lock, nothing changed', async () => {
    const s = setup(row({ role: 'OWNER' }));
    s.admins.findById.mockResolvedValueOnce(row());
    await expect(s.service.update(s.actor, TARGET_ID, body({ name: 'X' }))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'id', reason: 'OWNER_ROW' },
    });
    expect(s.calls).toEqual(['otp', 'actor FOR SHARE', 'target UPDATE']);
    expect(s.admins.updateNonOwner).not.toHaveBeenCalled();
    expect(s.sessions.revokeAllOf).not.toHaveBeenCalled();
    expect(s.alerts.adminAction).not.toHaveBeenCalled();
  });

  it('an unknown target is 404', async () => {
    const s = setup(null);
    await expect(s.service.update(s.actor, TARGET_ID, body({ name: 'X' }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('nothing to change: no write, no audit, no alert, auditId null', async () => {
    const s = setup();
    const res = await s.service.update(
      s.actor,
      TARGET_ID,
      body({ name: 'Operator', role: 'OPERATOR', isActive: true }),
    );
    expect(res).toMatchObject({ applied: false, auditId: null });
    expect(s.calls).toEqual(['otp', 'actor FOR SHARE', 'target UPDATE']);
  });

  it('a rename keeps the sessions; a role change ends them but expires no code', async () => {
    const rename = setup();
    await rename.service.update(rename.actor, TARGET_ID, body({ name: 'New name' }));
    expect(rename.sessions.revokeAllOf).not.toHaveBeenCalled();
    expect(rename.audits[0]?.before).toEqual({ name: 'Operator' });
    expect(rename.audits[0]?.after).toEqual({ name: 'New name', ...WHO });

    const role = setup();
    await role.service.update(role.actor, TARGET_ID, body({ role: 'SUPPORT' }));
    expect(role.calls).toEqual(expect.arrayContaining(['sessions']));
    expect(role.codes.expireOpenOf).not.toHaveBeenCalled();
    expect(role.audits[0]?.before).toEqual({ role: 'OPERATOR' });
    expect(role.audits[0]?.after).toEqual({ role: 'SUPPORT', revokedSessions: 2, ...WHO });
  });

  it('a reactivation ends the sessions and records whether the id is allowlisted', async () => {
    const s = setup(row({ isActive: false }));
    await s.service.update(s.actor, TARGET_ID, body({ isActive: true }));
    expect(s.sessions.revokeAllOf).toHaveBeenCalled();
    expect(s.codes.expireOpenOf).not.toHaveBeenCalled();
    expect(s.audits[0]?.after).toEqual({
      isActive: true,
      revokedSessions: 2,
      allowlisted: true,
      ...WHO,
    });
  });

  it('no code: OTP_REQUIRED before any transaction', async () => {
    const s = setup(row(), { stepUp: false });
    await expect(s.service.update(s.actor, TARGET_ID, body({ name: 'X' }))).rejects.toMatchObject({
      details: { field: 'otp', reason: 'OTP_REQUIRED' },
    });
    expect(s.calls).toEqual([]);
  });

  it('a failed write raises no alert', async () => {
    const s = setup();
    s.admins.createAudit.mockRejectedValueOnce(new Error('boom'));
    await expect(s.service.update(s.actor, TARGET_ID, body({ role: 'SUPPORT' }))).rejects.toThrow(
      'boom',
    );
    expect(s.alerts.adminAction).not.toHaveBeenCalled();
  });

  it('revoking all of one’s own sessions: target FOR SHARE, currentRevoked, always audited', async () => {
    const s = setup(row({ id: ACTOR_ID, role: 'OWNER' }));
    const res = await s.service.revokeAdminSessions(s.actor, ACTOR_ID, REASON);
    expect(s.calls).toEqual([
      'otp',
      'actor FOR SHARE',
      'target SHARE',
      'sessions lock',
      'sessions',
      'audit',
      'alert',
    ]);
    expect(res).toMatchObject({ revokedSessions: 2, currentRevoked: true, applied: true });
    expect(s.audits[0]).toMatchObject({ action: 'ADMIN_SESSIONS_REVOKE', before: null });
    expect(s.audits[0]?.after).toEqual({ revokedSessions: 2, currentRevoked: true, ...WHO });
  });

  it('one session: only that admin’s, by the session’s own admin id', async () => {
    const s = setup();
    const res = await s.service.revokeSession(s.actor, SESSION_ID, REASON);
    expect(s.sessions.revokeOne).toHaveBeenCalledWith(
      expect.anything(),
      SESSION_ID,
      TARGET_ID,
      NOW,
    );
    expect(s.admins.lockById).toHaveBeenCalledWith(expect.anything(), TARGET_ID, 'SHARE');
    expect(res).toMatchObject({ revokedSessions: 1, currentRevoked: false });
    expect(s.audits[0]).toMatchObject({ action: 'ADMIN_SESSION_REVOKE', before: null });
    expect(s.audits[0]?.after).toEqual({
      adminId: TARGET_ID,
      revokedSessions: 1,
      currentRevoked: false,
      ...WHO,
    });
    // The sessions' advisory lock comes last: after the target row, before the revoke.
    expect(s.calls.slice(2, 5)).toEqual(['target SHARE', 'sessions lock', 'session']);

    const gone = setup();
    gone.sessions.findById.mockResolvedValueOnce(null);
    await expect(gone.service.revokeSession(gone.actor, SESSION_ID, REASON)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
