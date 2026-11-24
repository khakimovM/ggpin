import type { AdminWriteKeyVoidBody } from '@repo/shared';
import { act, fireEvent, screen } from '@testing-library/react';
import { Undo2 } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminContext } from '../../../app/admin-context';
import { ApiError } from '../../../lib/api/errors';
import { meFixture } from '../../../lib/api/mock/fixtures';
import { voidWriteKey } from '../../../lib/api/writes-keys';
import {
  adminActionId,
  beginAttempt,
  markActionOutcomeUnknown,
  pendingAction,
  type AdminActionId,
} from '../../../lib/idempotency';
import { renderAdmin } from '../../../test/render';
import { voidAnswer } from '../../../test/void-answer';
import { ReasonDialog, type ReasonSubmit } from '../ReasonDialog';

// N-1 and the lock (9B-3, CR-S9b-1): no void while an attempt of the key is out; no submit while
// the outcome is unknown; the API's deadline 503 is a plain refusal (the key stays, not unknown).
vi.mock('../../../lib/api/writes-keys', () => ({ voidWriteKey: vi.fn() }));
const voidKey = vi.mocked(voidWriteKey);
const me = meFixture('OWNER', new Date('2026-11-24T09:00:00Z'));
const RESOLVE = 'Natijani aniqlash';
const REASON = 'Pul bank orqali qaytdi';
const VOIDED = (body: AdminWriteKeyVoidBody) => voidAnswer(me.admin.id, body, 'VOIDED');
let seq = 0;

function freshAction(): AdminActionId {
  seq += 1;
  return adminActionId(me.admin.id, 'payments.reverse', `n1ui_${seq}`);
}

function unknownAction(): { action: AdminActionId; key: string } {
  const action = freshAction();
  const { key, attempt } = beginAttempt(action);
  markActionOutcomeUnknown(action, key, { reason: REASON, conflict: false, attempt });
  return { action, key };
}

function renderDialog(action: AdminActionId, submit: (input: ReasonSubmit) => Promise<void>) {
  renderAdmin(
    <AdminContext.Provider value={me}>
      <ReasonDialog
        action={action}
        open
        onOpenChange={vi.fn()}
        title="Qaytarish"
        icon={Undo2}
        submitLabel="Qaytarish"
        actor={{ name: me.admin.name, role: me.admin.role }}
        onSubmit={submit}
      />
    </AdminContext.Provider>,
  );
}

const submitButton = () => screen.getByRole('button', { name: 'Qaytarish' });

afterEach(() => {
  voidKey.mockReset();
  window.sessionStorage.clear();
});

describe('the void while an attempt is out (N-1)', { timeout: 30_000 }, () => {
  it('an older attempt of the key still out (a closed dialog): no void is sent', () => {
    const { action, key } = unknownAction();
    beginAttempt(action);
    renderDialog(action, () => Promise.resolve());
    const resolve = screen.getByRole('button', { name: RESOLVE });
    expect(resolve).toBeDisabled();
    fireEvent.click(resolve);
    expect(voidKey).not.toHaveBeenCalled();
    expect(pendingAction(action)?.key).toBe(key);
  });

  it('the void wakes up by itself when that attempt ends elsewhere (F-1)', () => {
    const { action, key } = unknownAction();
    const older = beginAttempt(action);
    renderDialog(action, () => Promise.resolve());
    expect(screen.getByRole('button', { name: RESOLVE })).toBeDisabled();
    act(() => {
      markActionOutcomeUnknown(action, key, {
        reason: 'x',
        conflict: false,
        attempt: older.attempt,
      });
    });
    expect(screen.getByRole('button', { name: RESOLVE })).toBeEnabled();
  });
});

describe('the lock while the outcome is unknown (CR-S9b-1)', { timeout: 30_000 }, () => {
  it('submit stays disabled until the void settles the key; a forced submit sends nothing', () => {
    const { action } = unknownAction();
    const submit = vi.fn(() => Promise.resolve());
    renderDialog(action, submit);
    expect(submitButton()).toBeDisabled();
    const form = submitButton().closest('form');
    if (form === null) throw new Error('no form');
    fireEvent.submit(form);
    expect(submit).not.toHaveBeenCalled();
  });

  it('an unknown outcome arriving while the dialog is open locks it at once', async () => {
    const action = freshAction();
    renderDialog(action, () => Promise.reject(new ApiError({ status: 0, code: 'NETWORK' })));
    fireEvent.change(screen.getByRole('textbox', { name: /Sabab/ }), { target: { value: REASON } });
    fireEvent.click(submitButton());
    expect(await screen.findByRole('button', { name: RESOLVE })).toBeEnabled();
    expect(submitButton()).toBeDisabled();
    voidKey.mockImplementation(VOIDED);
    fireEvent.click(screen.getByRole('button', { name: RESOLVE }));
    await vi.waitFor(() => expect(submitButton()).toBeEnabled());
  });
});

describe('503 ADMIN_DEADLINE_EXCEEDED on the write (9-B Q3)', { timeout: 30_000 }, () => {
  it('"nothing written, resend is safe": the key stays, the outcome is not unknown', async () => {
    const action = freshAction();
    const submit = vi
      .fn<(input: ReasonSubmit) => Promise<void>>()
      .mockRejectedValueOnce(
        new ApiError({ status: 503, code: 'ADMIN_DEADLINE_EXCEEDED', fromServer: true }),
      )
      .mockResolvedValueOnce(undefined);
    renderDialog(action, submit);
    fireEvent.change(screen.getByRole('textbox', { name: /Sabab/ }), { target: { value: REASON } });
    fireEvent.click(submitButton());
    expect(await screen.findByText(/hech narsa yozilmadi/)).toBeInTheDocument();
    const entry = pendingAction(action);
    expect(entry).toMatchObject({ unknown: false, conflict: false });
    expect(screen.queryByRole('button', { name: RESOLVE })).toBeNull();
    expect(submitButton()).toBeEnabled();
    fireEvent.click(submitButton());
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    const keys = submit.mock.calls.map(([input]) => input.idempotencyKey);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[0]).toBe(entry?.key);
  });

  it('a proxy 503 (not our envelope) stays "unknown"', async () => {
    const action = freshAction();
    renderDialog(action, () =>
      Promise.reject(new ApiError({ status: 503, code: 'ADMIN_DEADLINE_EXCEEDED' })),
    );
    fireEvent.change(screen.getByRole('textbox', { name: /Sabab/ }), { target: { value: REASON } });
    fireEvent.click(submitButton());
    expect(await screen.findByRole('button', { name: RESOLVE })).toBeInTheDocument();
    expect(pendingAction(action)?.unknown).toBe(true);
  });
});
