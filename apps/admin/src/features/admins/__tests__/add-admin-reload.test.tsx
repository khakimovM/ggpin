// R-3 and the void target after a reload (9B-3, 9B-1 SA R-1): an add whose outcome was unknown
// when the tab reloaded opens empty (the fields sent lived in memory only) and locked, says why,
// and its void still names the new admin's Telegram ID, which was stored with the key.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { meFixture } from '../../../lib/api/mock/fixtures';
import { PENDING_ACTIONS_STORAGE_KEY } from '../../../lib/idempotency-store';
import { voidAnswer } from '../../../test/void-answer';
import { NOW } from './admins-kit';

vi.mock('../../../lib/api/writes-keys', () => ({ voidWriteKey: vi.fn() }));
vi.mock('../../../lib/api/writes-admins', () => ({ createAdmin: vi.fn() }));
vi.mock('../../../lib/api/confirmations', () => ({ requestConfirmation: vi.fn() }));

const me = meFixture('OWNER', NOW);
const KEY = 'reload-key-000001';

afterEach(() => {
  window.sessionStorage.clear();
});

/** The tab reloads with this registry in sessionStorage: fresh modules read it on import. */
async function reloadWith(stored: object[]) {
  window.sessionStorage.setItem(PENDING_ACTIONS_STORAGE_KEY, JSON.stringify(stored));
  vi.resetModules();
  const [{ AddAdminDialog }, { renderAdmin }, { AdminContext }, keys, registry] = await Promise.all(
    [
      import('../AddAdminDialog'),
      import('../../../test/render'),
      import('../../../app/admin-context'),
      import('../../../lib/api/writes-keys'),
      import('../../../lib/idempotency'),
    ],
  );
  renderAdmin(
    <AdminContext.Provider value={me}>
      <AddAdminDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />
    </AdminContext.Provider>,
  );
  return { voidKey: vi.mocked(keys.voidWriteKey), registry };
}

describe('the add dialog after a reload with an unknown outcome', { timeout: 30_000 }, () => {
  it('opens empty and locked, explains why, and voids with the stored Telegram ID', async () => {
    const user = userEvent.setup();
    const { voidKey, registry } = await reloadWith([
      {
        adminId: me.admin.id,
        kind: 'admins.create',
        targetId: 'new',
        key: KEY,
        unknown: false,
        conflict: false,
        // The reload came while the request was out: unknown now.
        inFlight: true,
        createdAt: 1,
        sentAt: 1,
        voidTargetId: '5550000009',
      },
    ]);
    voidKey.mockImplementation((body) => voidAnswer(me.admin.id, body, 'VOIDED'));
    const telegramId = screen.getByRole('textbox', { name: 'Telegram ID' });
    expect(telegramId).toHaveValue('');
    expect(telegramId).toBeDisabled();
    expect(screen.getByText(/sahifa yangilanganda o‘chdi/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Natijani aniqlash' }));
    await waitFor(() => expect(voidKey).toHaveBeenCalled());
    expect(voidKey.mock.calls[0]?.[0]).toEqual({
      idempotencyKey: KEY,
      action: 'admins.create',
      targetId: '5550000009',
    });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Telegram ID' })).toBeEnabled());
    expect(screen.queryByText(/sahifa yangilanganda o‘chdi/)).toBeNull();
    const action = registry.adminActionId(me.admin.id, 'admins.create', 'new');
    expect(registry.pendingAction(action)?.key).not.toBe(KEY);
  });
});
