// CR-S9b-4: after an action the reload may remove the button focus went back to; focus stays in
// the row instead of falling to <body>. S9b CR R-1: it does so once, never on a later refresh;
// R-2: the cell names whose actions it holds and shows its focus.
import type { AdminAccount } from '@repo/shared';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestConfirmation } from '../../../lib/api/confirmations';
import { revokeAdminSessions, updateAdmin } from '../../../lib/api/writes-admins';
import { AdminRowActions } from '../AdminRowActions';
import { REASON, adminAt, asOwner, result, submitButton, typeCode } from './admins-kit';

vi.mock('../../../lib/api/writes-admins', () => ({
  createAdmin: vi.fn(),
  updateAdmin: vi.fn(),
  revokeAdminSessions: vi.fn(),
  revokeAdminSession: vi.fn(),
}));
vi.mock('../../../lib/api/confirmations', () => ({ requestConfirmation: vi.fn() }));

/** The page's reload after an action: the test hands the row its next state. */
const page = { reload: (admin: AdminAccount): void => void admin };

function Row({ first }: { first: AdminAccount }) {
  const [admin, setAdmin] = useState(first);
  useEffect(() => {
    page.reload = setAdmin;
  }, []);
  return <AdminRowActions admin={admin} />;
}

afterEach(() => {
  vi.mocked(updateAdmin).mockReset();
  vi.mocked(revokeAdminSessions).mockReset();
  vi.mocked(requestConfirmation).mockReset();
});

async function confirm(user: ReturnType<typeof userEvent.setup>, cta: string) {
  vi.mocked(requestConfirmation).mockResolvedValue({ challengeId: 'ch_f', expiresInSec: 180 });
  await user.type(screen.getByRole('textbox', { name: /Sabab/ }), REASON);
  await typeCode(user);
  await user.click(submitButton(cta));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

// Each case walks a reason, a six-digit code and a reload: 1.6–2.1 s alone, up to 6.1 s in the
// parallel turbo run, so the block gets a budget with room instead of the 5 s default.
describe('focus after a row action', { timeout: 30_000 }, () => {
  it('end sessions → the button is gone at 0 sessions → focus goes to the row, not <body>', async () => {
    const user = userEvent.setup();
    const admin = { ...adminAt(1), id: 'mkadm000301', activeSessions: 1 };
    vi.mocked(revokeAdminSessions).mockResolvedValue({
      revokedSessions: 1,
      currentRevoked: false,
      auditId: 'a0000000000000000000000000000005',
      applied: true,
    });
    asOwner(<Row first={admin} />);
    await user.click(screen.getByRole('button', { name: 'Sessiyalarni yopish: Dilshod K.' }));
    await confirm(user, 'Yopish');
    act(() => page.reload({ ...admin, activeSessions: 0 }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'O‘zgartirish: Dilshod K.' }),
      ),
    );
  });

  it('deactivate → the button turns into reactivate and keeps the focus', async () => {
    const user = userEvent.setup();
    const admin = { ...adminAt(1), id: 'mkadm000302' };
    vi.mocked(updateAdmin).mockResolvedValue(result({ ...admin, isActive: false }));
    asOwner(<Row first={admin} />);
    await user.click(screen.getByRole('button', { name: 'Deaktivatsiya: Dilshod K.' }));
    await confirm(user, 'Deaktivatsiya');
    act(() => page.reload({ ...admin, isActive: false, activeSessions: 0 }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Faollashtirish: Dilshod K.' }),
      ),
    );
  });

  it('brings focus back once: a later background refresh never pulls it into the row (R-1)', async () => {
    const user = userEvent.setup();
    const admin = { ...adminAt(1), id: 'mkadm000303', activeSessions: 1 };
    vi.mocked(revokeAdminSessions).mockResolvedValue({
      revokedSessions: 1,
      currentRevoked: false,
      auditId: 'a0000000000000000000000000000006',
      applied: true,
    });
    asOwner(<Row first={admin} />);
    await user.click(screen.getByRole('button', { name: 'Sessiyalarni yopish: Dilshod K.' }));
    await confirm(user, 'Yopish');
    act(() => page.reload({ ...admin, activeSessions: 0 }));
    const change = screen.getByRole('button', { name: 'O‘zgartirish: Dilshod K.' });
    await waitFor(() => expect(document.activeElement).toBe(change));
    // The admin moves on in a way that leaves focus on <body> (no blur target)...
    act(() => change.blur());
    expect(document.activeElement).toBe(document.body);
    // ...and a background refresh changes the row's buttons again: focus must stay where it is.
    act(() => page.reload({ ...admin, activeSessions: 2 }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(document.activeElement).toBe(document.body);
  });

  it('the cell is named after the admin and shows its focus ring (R-2)', () => {
    asOwner(<Row first={{ ...adminAt(1), id: 'mkadm000304' }} />);
    const group = screen.getByRole('group', { name: 'Amallar: Dilshod K.' });
    expect(group.className).toContain('focus-visible:ring-2');
    expect(group.className).not.toMatch(/(^|\s)outline-none(\s|$)/);
  });
});
