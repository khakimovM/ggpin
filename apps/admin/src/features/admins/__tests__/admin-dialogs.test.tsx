// S9b: the admins page's dialogs with the API modules faked (plan §7.2): the code step, the OWNER
// row read-only but for its sessions (Q7), one request per double click, only what changed is sent,
// every button by the permission of its own write, and the own session ending → /login.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminContext } from '../../../app/admin-context';
import { RootLayout } from '../../../app/RootLayout';
import { requestConfirmation } from '../../../lib/api/confirmations';
import { meFixture } from '../../../lib/api/mock/fixtures';
import { createAdmin, revokeAdminSession, updateAdmin } from '../../../lib/api/writes-admins';
import { qk } from '../../../lib/query-keys';
import { renderAdmin } from '../../../test/render';
import { AddAdminDialog } from '../AddAdminDialog';
import { AdminChangeDialog } from '../AdminChangeDialog';
import { AdminRowActions } from '../AdminRowActions';
import { RevokeSessionsDialog } from '../RevokeSessionsDialog';
import { NOW, REASON, adminAt, asOwner, result, typeCode } from './admins-kit';

vi.mock('../../../lib/api/writes-admins', () => ({
  createAdmin: vi.fn(),
  updateAdmin: vi.fn(),
  revokeAdminSessions: vi.fn(),
  revokeAdminSession: vi.fn(),
}));
vi.mock('../../../lib/api/confirmations', () => ({ requestConfirmation: vi.fn() }));

const OWNER_ROW = adminAt(0);
const OPERATOR_ROW = adminAt(1);

afterEach(() => {
  vi.mocked(createAdmin).mockReset();
  vi.mocked(updateAdmin).mockReset();
  vi.mocked(revokeAdminSession).mockReset();
  vi.mocked(requestConfirmation).mockReset();
});

// The case types four fields, a reason and a six-digit code: 2.7–3.4 s alone, up to 8.0 s with the web
// suite running beside it (turbo --concurrency=2), over the 5 s default. A timed-out body keeps
// typing into the next case (seen as "kYangi…" in the change dialog), so this block gets its own budget.
describe('add an admin: the code step is bound to the new admin', { timeout: 30_000 }, () => {
  it('no error on open; the code opens once the fields are valid; the body carries the code', async () => {
    const user = userEvent.setup();
    vi.mocked(requestConfirmation).mockResolvedValue({ challengeId: 'ch_add', expiresInSec: 180 });
    const added = { ...OPERATOR_ROW, id: 'mkadm000100', telegramId: '5550000002', name: 'Ali V.' };
    vi.mocked(createAdmin).mockResolvedValue(result({ ...added, allowlisted: false }));
    const onCreated = vi.fn();
    asOwner(<AddAdminDialog open onOpenChange={vi.fn()} onCreated={onCreated} />);
    // S8b lesson: an empty field shows no error until it is left.
    expect(screen.queryByText(/faqat raqamlardan/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Kodni olish' })).toBeDisabled();
    const telegramId = screen.getByRole('textbox', { name: 'Telegram ID' });
    await user.type(telegramId, '0abc');
    await user.tab();
    expect(screen.getByText(/faqat raqamlardan/)).toBeInTheDocument();
    await user.clear(telegramId);
    await user.type(telegramId, '5550000002');
    await user.type(screen.getByRole('textbox', { name: 'Ism' }), 'Ali V.');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Rol' }), 'OPERATOR');
    await user.type(screen.getByRole('textbox', { name: /Sabab/ }), REASON);
    expect(screen.getByRole('button', { name: 'Qo‘shish' })).toBeDisabled();
    await typeCode(user);
    expect(requestConfirmation).toHaveBeenCalledWith({
      action: 'admins.create',
      telegramId: '5550000002',
      name: 'Ali V.',
      role: 'OPERATOR',
    });
    await user.click(screen.getByRole('button', { name: 'Qo‘shish' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createAdmin).mock.calls[0]?.[0]).toEqual({
      telegramId: '5550000002',
      name: 'Ali V.',
      role: 'OPERATOR',
      reason: REASON,
      otp: { challengeId: 'ch_add', code: '123456' },
    });
  });
});

describe('admin rows', () => {
  it('an OWNER row is read-only: no change or deactivate, only ending its sessions (Q7)', () => {
    asOwner(<AdminRowActions admin={OWNER_ROW} />);
    expect(screen.getByText('Faqat CLI')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /O‘zgartirish|Deaktivatsiya|Faollashtirish/ }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Sessiyalarni yopish: Aziz O.' }),
    ).toBeInTheDocument();
  });

  it('an OPERATOR row has change, end sessions and deactivate', () => {
    asOwner(<AdminRowActions admin={OPERATOR_ROW} />);
    for (const name of ['O‘zgartirish', 'Sessiyalarni yopish', 'Deaktivatsiya']) {
      expect(screen.getByRole('button', { name: `${name}: Dilshod K.` })).toBeInTheDocument();
    }
    expect(screen.queryByText('Faqat CLI')).toBeNull();
  });

  it('each button only with the permission of the write it sends', () => {
    asOwner(<AdminRowActions admin={OPERATOR_ROW} />, ['admins.update']);
    expect(screen.queryByRole('button', { name: /O‘zgartirish|Deaktivatsiya/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Sessiyalarni yopish/ })).toBeInTheDocument();
  });

  it('without admins.sessionsRevoke the end-sessions button is gone, the rest stays', () => {
    asOwner(<AdminRowActions admin={OPERATOR_ROW} />, ['admins.sessionsRevoke']);
    expect(screen.queryByRole('button', { name: /Sessiyalarni yopish/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Deaktivatsiya/ })).toBeInTheDocument();
  });
});

describe('change dialog', () => {
  it('sends only the changed role; a double click sends once', async () => {
    const user = userEvent.setup();
    vi.mocked(requestConfirmation).mockResolvedValue({ challengeId: 'ch_chg', expiresInSec: 180 });
    let release: (value: ReturnType<typeof result>) => void = () => {};
    vi.mocked(updateAdmin).mockImplementation(() => new Promise((resolve) => (release = resolve)));
    asOwner(<AdminChangeDialog admin={OPERATOR_ROW} mode="change" onOpenChange={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Hech narsa o‘zgarmagan/)).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Rol' }), 'SUPPORT');
    await user.type(screen.getByRole('textbox', { name: /Sabab/ }), REASON);
    await typeCode(user);
    expect(requestConfirmation).toHaveBeenCalledWith({
      action: 'admins.update',
      targetId: OPERATOR_ROW.id,
      role: 'SUPPORT',
    });
    const form = screen.getByRole('button', { name: 'Saqlash' }).closest('form');
    if (form === null) throw new Error('no form');
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(updateAdmin).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateAdmin).mock.calls[0]?.[1]).toEqual({
      role: 'SUPPORT',
      reason: REASON,
      otp: { challengeId: 'ch_chg', code: '123456' },
    });
    await act(async () => {
      release(result({ ...OPERATOR_ROW, role: 'SUPPORT' }));
      await Promise.resolve();
    });
  });
});

describe('ending the own current session', () => {
  it('currentRevoked: the panel drops the session and goes to /login', async () => {
    const user = userEvent.setup();
    vi.mocked(requestConfirmation).mockResolvedValue({ challengeId: 'ch_end', expiresInSec: 180 });
    vi.mocked(revokeAdminSession).mockResolvedValue({
      revokedSessions: 1,
      currentRevoked: true,
      auditId: 'a0000000000000000000000000000002',
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
                    target={{
                      kind: 'session',
                      sessionId: 'mkadm000001s0',
                      adminName: 'Aziz O.',
                      adminRole: 'OWNER',
                      device: 'Chrome · Windows',
                      current: true,
                    }}
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
    expect(screen.getByText(/joriy sessiyangiz/)).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: /Sabab/ }), REASON);
    await typeCode(user);
    await user.click(screen.getByRole('button', { name: 'Yakunlash' }));
    expect(await screen.findByText('login page')).toBeInTheDocument();
    expect(view.queryClient.getQueryData(qk.auth.me())).toBeNull();
  });
});
