// S9b review round: a replayed answer of an old key is not a success (CR-S9b-1), the registry
// targets and the outcome look-ups (CR-S9b-2), the add dialog locked while its outcome is unknown
// (SA-I2), and ending the own sessions from the OWNER row → /login (CR-S9b-3).
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminContext } from '../../../app/admin-context';
import { RootLayout } from '../../../app/RootLayout';
import { requestConfirmation } from '../../../lib/api/confirmations';
import { ApiError } from '../../../lib/api/errors';
import { meFixture } from '../../../lib/api/mock/fixtures';
import { listAudit } from '../../../lib/api/people';
import { listAdmins } from '../../../lib/api/reads';
import { createAdmin, revokeAdminSessions, updateAdmin } from '../../../lib/api/writes-admins';
import { qk } from '../../../lib/query-keys';
import { renderAdmin } from '../../../test/render';
import { AddAdminDialog } from '../AddAdminDialog';
import { AdminChangeDialog, changeTargetOf, type AdminChangeMode } from '../AdminChangeDialog';
import { RevokeSessionsDialog } from '../RevokeSessionsDialog';
import { NOW, REASON, adminAt, asOwner, result, submitButton, typeCode } from './admins-kit';

vi.mock('../../../lib/api/writes-admins', () => ({
  createAdmin: vi.fn(),
  updateAdmin: vi.fn(),
  revokeAdminSessions: vi.fn(),
  revokeAdminSession: vi.fn(),
}));
vi.mock('../../../lib/api/confirmations', () => ({ requestConfirmation: vi.fn() }));
vi.mock('../../../lib/api/people', () => ({ listAudit: vi.fn() }));
vi.mock('../../../lib/api/reads', async (original) => ({
  ...(await original<typeof import('../../../lib/api/reads')>()),
  listAdmins: vi.fn(),
}));

const ACTOR = meFixture('OWNER', NOW).admin.id;
const OPERATOR_ROW = adminAt(1);
const STALE = /holat o‘shandan beri o‘zgargan/;
const REPLAYED = /Bu amal avval bajarilgan/;
const CTA: Record<AdminChangeMode, string> = {
  change: 'Saqlash',
  deactivate: 'Deaktivatsiya',
  reactivate: 'Faollashtirish',
};
const lost = () => new ApiError({ status: 0, code: 'NETWORK' });
const emptyAudit = { items: [], meta: { page: 1, limit: 100, total: 0 } };

afterEach(() => {
  for (const fn of [createAdmin, updateAdmin, revokeAdminSessions, listAudit, listAdmins]) {
    vi.mocked(fn).mockReset();
  }
  vi.mocked(requestConfirmation).mockReset();
});

async function submitChange(
  user: ReturnType<typeof userEvent.setup>,
  admin: typeof OPERATOR_ROW,
  mode: AdminChangeMode,
) {
  vi.mocked(requestConfirmation).mockResolvedValue({ challengeId: 'ch_r', expiresInSec: 180 });
  const view = asOwner(<AdminChangeDialog admin={admin} mode={mode} onOpenChange={vi.fn()} />);
  const reason = screen.getByRole('textbox', { name: /Sabab/ });
  await user.clear(reason);
  await user.type(reason, REASON);
  await typeCode(user);
  await user.click(submitButton(CTA[mode]));
  return view;
}

const keyOf = (call: number) => vi.mocked(updateAdmin).mock.calls[call]?.[2];

// The first case walks a dialog through four full submits (reason, code, send); under the
// parallel turbo run that exceeded the 5 s default, so this block gets its own budget.
describe('CR-S9b-1: a replay of an old key is not reported as done', { timeout: 30_000 }, () => {
  it('unknown deactivation → reactivation → deactivation again: a warning, then a new key', async () => {
    const user = userEvent.setup();
    const target = { ...OPERATOR_ROW, id: 'mkadm000201' };
    vi.mocked(updateAdmin).mockRejectedValueOnce(lost());
    const first = await submitChange(user, target, 'deactivate');
    expect(await screen.findByRole('button', { name: 'Bajarilganini tekshirish' })).toBeVisible();
    first.unmount();

    vi.mocked(updateAdmin).mockResolvedValueOnce(result({ ...target, isActive: true }));
    const second = await submitChange(user, { ...target, isActive: false }, 'reactivate');
    await waitFor(() => expect(updateAdmin).toHaveBeenCalledTimes(2));
    expect(keyOf(1)).not.toBe(keyOf(0));
    second.unmount();

    // The server answers the old key with the first result; the admin is active again now.
    vi.mocked(updateAdmin).mockResolvedValueOnce(result({ ...target, isActive: false }, false));
    vi.mocked(listAdmins).mockResolvedValue([{ ...target, isActive: true }]);
    const third = await submitChange(user, target, 'deactivate');
    expect(await screen.findByText(STALE)).toBeInTheDocument();
    expect(keyOf(2)).toBe(keyOf(0));
    expect(screen.queryByText(REPLAYED)).toBeNull();
    third.unmount();

    // The replay settled the old key: the next try is a real request with a new key.
    vi.mocked(updateAdmin).mockResolvedValueOnce(result({ ...target, isActive: false }));
    await submitChange(user, target, 'deactivate');
    await waitFor(() => expect(updateAdmin).toHaveBeenCalledTimes(4));
    expect(keyOf(3)).not.toBe(keyOf(0));
  });

  it('a replay whose state still holds says "replayed", not the warning', async () => {
    const user = userEvent.setup();
    const target = { ...OPERATOR_ROW, id: 'mkadm000204' };
    vi.mocked(updateAdmin).mockResolvedValueOnce(result({ ...target, isActive: false }, false));
    vi.mocked(listAdmins).mockResolvedValue([{ ...target, isActive: false }]);
    await submitChange(user, target, 'deactivate');
    expect(await screen.findByText(REPLAYED)).toBeInTheDocument();
    expect(screen.queryByText(STALE)).toBeNull();
  });

  it('end all sessions replayed: no old count; sessions open now → the warning', async () => {
    const user = userEvent.setup();
    vi.mocked(requestConfirmation).mockResolvedValue({ challengeId: 'ch_ra', expiresInSec: 180 });
    vi.mocked(revokeAdminSessions).mockResolvedValue({
      revokedSessions: 3,
      currentRevoked: false,
      auditId: 'a0000000000000000000000000000003',
      applied: false,
    });
    vi.mocked(listAdmins).mockResolvedValue([{ ...OPERATOR_ROW, activeSessions: 1 }]);
    asOwner(
      <RevokeSessionsDialog
        target={{ kind: 'admin', admin: OPERATOR_ROW }}
        onOpenChange={vi.fn()}
      />,
    );
    await user.type(screen.getByRole('textbox', { name: /Sabab/ }), REASON);
    await typeCode(user);
    await user.click(submitButton('Yopish'));
    expect(await screen.findByText(STALE)).toBeInTheDocument();
    expect(screen.queryByText(/3 ta sessiya/)).toBeNull();
  });
});

describe('CR-S9b-2: registry targets and outcome look-ups', () => {
  it('each change mode has its own registry target', () => {
    expect(changeTargetOf('mkadm000002', 'change')).toBe('mkadm000002');
    expect(changeTargetOf('mkadm000002', 'deactivate')).toBe('mkadm000002-deactivate');
    expect(changeTargetOf('mkadm000002', 'reactivate')).toBe('mkadm000002-reactivate');
  });

  it('an unknown deactivation leaves the change dialog clean and is looked up by the admin id', async () => {
    const user = userEvent.setup();
    const target = { ...OPERATOR_ROW, id: 'mkadm000202' };
    vi.mocked(updateAdmin).mockRejectedValueOnce(lost());
    vi.mocked(listAudit).mockResolvedValue(emptyAudit);
    const view = await submitChange(user, target, 'deactivate');
    await user.click(await screen.findByRole('button', { name: 'Bajarilganini tekshirish' }));
    await waitFor(() => expect(listAudit).toHaveBeenCalled());
    expect(vi.mocked(listAudit).mock.calls[0]?.[0]).toMatchObject({
      actorId: ACTOR,
      targetId: target.id,
    });
    view.unmount();
    asOwner(<AdminChangeDialog admin={target} mode="change" onOpenChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Bajarilganini tekshirish' })).toBeNull();
  });

  it('an unknown add locks its fields (SA-I2) and is looked up among the ADMIN_CREATE rows', async () => {
    const user = userEvent.setup();
    vi.mocked(requestConfirmation).mockResolvedValue({ challengeId: 'ch_add', expiresInSec: 180 });
    vi.mocked(createAdmin).mockRejectedValueOnce(lost());
    vi.mocked(listAudit).mockResolvedValue(emptyAudit);
    asOwner(<AddAdminDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: 'Telegram ID' }), '5550000003');
    await user.type(screen.getByRole('textbox', { name: 'Ism' }), 'Ali V.');
    await user.type(screen.getByRole('textbox', { name: /Sabab/ }), REASON);
    await typeCode(user);
    expect(screen.getByRole('textbox', { name: 'Telegram ID' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Qo‘shish' }));
    await user.click(await screen.findByRole('button', { name: 'Bajarilganini tekshirish' }));
    expect(screen.getByRole('textbox', { name: 'Telegram ID' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Ism' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Rol' })).toBeDisabled();
    await waitFor(() => expect(listAudit).toHaveBeenCalled());
    const query = vi.mocked(listAudit).mock.calls[0]?.[0];
    expect(query).toMatchObject({ actorId: ACTOR, action: 'ADMIN_CREATE', page: 1 });
    // Its audit row names the new admin, never the registry target 'new'.
    expect(query).not.toHaveProperty('targetId');
  });
});

describe('CR-S9b-3: ending all own sessions from the OWNER row', () => {
  it('currentRevoked → the panel drops the session and goes to /login', async () => {
    const user = userEvent.setup();
    const owner = adminAt(0);
    vi.mocked(requestConfirmation).mockResolvedValue({ challengeId: 'ch_own', expiresInSec: 180 });
    vi.mocked(revokeAdminSessions).mockResolvedValue({
      revokedSessions: 2,
      currentRevoked: true,
      auditId: 'a0000000000000000000000000000004',
      applied: true,
    });
    const me = meFixture('OWNER', NOW);
    const view = renderAdmin(
      <MemoryRouter initialEntries={['/admins']}>
        <AdminContext.Provider value={me}>
          <Routes>
            <Route element={<RootLayout />}>
              <Route
                path="/admins"
                element={
                  <RevokeSessionsDialog
                    target={{ kind: 'admin', admin: owner }}
                    onOpenChange={vi.fn()}
                  />
                }
              />
              <Route path="/login" element={<p>login page</p>} />
            </Route>
          </Routes>
        </AdminContext.Provider>
      </MemoryRouter>,
    );
    view.queryClient.setQueryData(qk.auth.me(), me);
    expect(screen.getByText(/egalarga ogohlantirish/)).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: /Sabab/ }), REASON);
    await typeCode(user);
    await user.click(submitButton('Yopish'));
    expect(await screen.findByText('login page')).toBeInTheDocument();
    expect(vi.mocked(revokeAdminSessions).mock.calls[0]?.[0]).toBe(owner.id);
    expect(view.queryClient.getQueryData(qk.auth.me())).toBeNull();
  });
});
