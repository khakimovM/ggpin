import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminContext } from '../../../app/admin-context';
import { ShellHeader } from '../../../app/shell/ShellHeader';
import { logoutAdmin } from '../../../lib/api/auth';
import { ApiError } from '../../../lib/api/errors';
import {
  actionIdempotencyKey,
  adminActionId,
  markActionOutcomeUnknown,
  pendingAction,
} from '../../../lib/idempotency';
import { meFixture } from '../../../lib/api/mock/fixtures';
import { qk } from '../../../lib/query-keys';
import { renderAdmin } from '../../../test/render';
import { signOut } from '../use-admin-session';

vi.mock('../../../lib/api/auth', () => ({ logoutAdmin: vi.fn() }));
const logout = vi.mocked(logoutAdmin);

const ME = meFixture('OWNER', new Date('2026-11-17T09:00:00Z'));

function renderHeader() {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <AdminContext.Provider value={ME}>
            <ShellHeader />
          </AdminContext.Provider>
        ),
      },
      { path: '/login', element: <h1>login sahifasi</h1> },
    ],
    { initialEntries: ['/'] },
  );
  const result = renderAdmin(<RouterProvider router={router} />);
  result.queryClient.setQueryData(qk.auth.me(), ME);
  return { ...result, router };
}

beforeEach(() => {
  logout.mockReset();
});

describe('signOut (SA L-1)', () => {
  it('is done on a 2xx and on a 404 in our envelope', async () => {
    logout.mockResolvedValueOnce();
    await expect(signOut()).resolves.toBe('signedOut');
    logout.mockRejectedValueOnce(
      new ApiError({ status: 404, code: 'NOT_FOUND', fromServer: true }),
    );
    await expect(signOut()).resolves.toBe('alreadyGone');
  });

  it.each([
    ['no answer', new ApiError({ status: 0, code: 'NETWORK' })],
    ['a 5xx', new ApiError({ status: 503, code: 'INTERNAL_ERROR', fromServer: true })],
    ['a 404 page from a proxy', new ApiError({ status: 404, code: 'NOT_FOUND' })],
    [
      'a refusal other than 404',
      new ApiError({ status: 429, code: 'RATE_LIMITED', fromServer: true }),
    ],
  ])('stays an error after %s', async (_name, failure) => {
    logout.mockRejectedValueOnce(failure);
    await expect(signOut()).rejects.toBe(failure);
  });
});

let seq = 0;
/** An action left with an unknown outcome, as ReasonDialog leaves it. */
function unknownAction() {
  seq += 1;
  const action = adminActionId(ME.admin.id, 'orders.refund', `logout_${seq}`);
  markActionOutcomeUnknown(action, actionIdempotencyKey(action), {
    reason: 'Sabab matni bor',
    conflict: false,
  });
  return action;
}

/** An action whose key was only read (no attempt with an unknown outcome). */
function plainAction() {
  seq += 1;
  const action = adminActionId(ME.admin.id, 'orders.cancel', `logout_${seq}`);
  actionIdempotencyKey(action);
  return action;
}

describe('ShellHeader sign-out', () => {
  it('keeps the session and offers a retry when the outcome is not sure', async () => {
    const user = userEvent.setup();
    logout.mockRejectedValueOnce(new ApiError({ status: 0, code: 'NETWORK' }));
    const action = unknownAction();
    const plain = plainAction();
    const { queryClient, router } = renderHeader();
    await user.click(screen.getByRole('button', { name: 'Chiqish' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Chiqib bo‘lmadi');
    expect(router.state.location.pathname).toBe('/');
    expect(queryClient.getQueryData(qk.auth.me())).toEqual(ME);
    expect(pendingAction(action)?.unknown).toBe(true);

    logout.mockResolvedValueOnce();
    await user.click(screen.getByRole('button', { name: 'Chiqish' }));
    expect(await screen.findByRole('heading', { name: 'login sahifasi' })).toBeInTheDocument();
    expect(queryClient.getQueryData(qk.auth.me())).toBeNull();
    expect(logout).toHaveBeenCalledTimes(2);
    // A confirmed sign-out drops only plain keys; an unknown one outlives it (SA L-1).
    expect(pendingAction(plain)).toBeNull();
    expect(pendingAction(action)?.unknown).toBe(true);
  });

  it('signs out when the session was already gone (404) but keeps the pending keys', async () => {
    const user = userEvent.setup();
    const action = unknownAction();
    const plain = plainAction();
    const key = pendingAction(action)?.key;
    logout.mockRejectedValueOnce(
      new ApiError({ status: 404, code: 'NOT_FOUND', fromServer: true }),
    );
    const { queryClient } = renderHeader();
    await user.click(screen.getByRole('button', { name: 'Chiqish' }));
    await waitFor(() => expect(queryClient.getQueryData(qk.auth.me())).toBeNull());
    expect(await screen.findByRole('heading', { name: 'login sahifasi' })).toBeInTheDocument();
    expect(pendingAction(action)).toMatchObject({ key, unknown: true });
    expect(pendingAction(plain)).not.toBeNull();
  });
});
