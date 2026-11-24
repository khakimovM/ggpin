import type { AdminWriteKeyVoidBody, AdminWriteKeyVoidResponse } from '@repo/shared';
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
import { expectedAuditId } from '../../../lib/idempotency-outcome';
import { renderAdmin } from '../../../test/render';
import { voidAnswer } from '../../../test/void-answer';
import { ReasonDialog } from '../ReasonDialog';

// «Natijani aniqlash» = the key void (docs/04, 9-B Q2 = A): APPLIED closes, VOIDED gives a new
// key at once, anything else keeps the key. No wait and no audit search any more.
vi.mock('../../../lib/api/writes-keys', () => ({ voidWriteKey: vi.fn() }));
const voidKey = vi.mocked(voidWriteKey);

const me = meFixture('OWNER', new Date('2026-11-24T09:00:00Z'));
const RESOLVE = 'Natijani aniqlash';
const AT = '2026-11-24T09:00:00.000Z';
// The API names the asked key's own audit row (SA L-1).
const VOIDED = (body: AdminWriteKeyVoidBody) => voidAnswer(me.admin.id, body, 'VOIDED');
const APPLIED = (body: AdminWriteKeyVoidBody) =>
  voidAnswer(me.admin.id, body, 'APPLIED', 'PAYMENT_REVERSE');
let seq = 0;

/** An action whose last attempt has an unknown outcome. */
function unknownAction(conflict = false): { action: AdminActionId; key: string } {
  seq += 1;
  const action = adminActionId(me.admin.id, 'payments.reverse', `outcome_${seq}`);
  const { key, attempt } = beginAttempt(action);
  markActionOutcomeUnknown(action, key, { reason: 'Pul bank orqali qaytdi', conflict, attempt });
  return { action, key };
}

function renderDialog(action: AdminActionId, submit = vi.fn(() => Promise.resolve())) {
  const found = vi.fn();
  const restart = vi.fn();
  const onOpenChange = vi.fn();
  renderAdmin(
    <AdminContext.Provider value={me}>
      <ReasonDialog
        action={action}
        open
        onOpenChange={onOpenChange}
        title="Qaytarish"
        icon={Undo2}
        submitLabel="Qaytarish"
        actor={{ name: me.admin.name, role: me.admin.role }}
        onOutcomeFound={found}
        onRestart={restart}
        onSubmit={submit}
      />
    </AdminContext.Provider>,
  );
  return { found, restart, onOpenChange, submit };
}

const submitButton = () => screen.getByRole('button', { name: 'Qaytarish' });

afterEach(() => {
  voidKey.mockReset();
  window.sessionStorage.clear();
});

describe('OutcomeCheck: the key void (9B-3)', { timeout: 30_000 }, () => {
  it('APPLIED: the dialog closes, the entry is cleared, the audit row is handed on', async () => {
    const { action, key } = unknownAction();
    voidKey.mockImplementation(APPLIED);
    const auditId = await expectedAuditId(me.admin.id, key);
    const { found, onOpenChange } = renderDialog(action);
    fireEvent.click(screen.getByRole('button', { name: RESOLVE }));
    await vi.waitFor(() =>
      expect(found).toHaveBeenCalledWith({ auditId, action: 'PAYMENT_REVERSE' }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(pendingAction(action)).toBeNull();
    expect(voidKey).toHaveBeenCalledWith({
      idempotencyKey: key,
      action: 'payments.reverse',
      targetId: `outcome_${seq}`,
    });
  });

  it('VOIDED: a new key at once; the form opens again and sends with it', async () => {
    const { action, key } = unknownAction();
    voidKey.mockImplementation(VOIDED);
    const { restart, submit } = renderDialog(action);
    expect(submitButton()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: RESOLVE }));
    expect(await screen.findByText(/Avvalgi so‘rov bajarilmagan/)).toBeInTheDocument();
    expect(restart).toHaveBeenCalled();
    const next = pendingAction(action);
    expect(next?.key).not.toBe(key);
    expect(next).toMatchObject({ unknown: false, conflict: false });
    expect(screen.queryByRole('button', { name: RESOLVE })).toBeNull();
    expect(submitButton()).toBeEnabled();
    fireEvent.click(submitButton());
    await vi.waitFor(() =>
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: next?.key })),
    );
  });

  it.each([
    [
      '404 (role, session or CSRF)',
      new ApiError({ status: 404, code: 'NOT_FOUND', fromServer: true }),
    ],
    [
      '503 ADMIN_DEADLINE_EXCEEDED',
      new ApiError({ status: 503, code: 'ADMIN_DEADLINE_EXCEEDED', fromServer: true }),
    ],
    ['no answer or the timeout', new ApiError({ status: 0, code: 'NETWORK' })],
  ])(
    'void %s: never "voided"; the key stays, the form stays locked, ask again',
    async (_n, error) => {
      const { action, key } = unknownAction();
      voidKey.mockRejectedValueOnce(error).mockImplementationOnce(VOIDED);
      const { restart } = renderDialog(action);
      fireEvent.click(screen.getByRole('button', { name: RESOLVE }));
      expect(await screen.findByText(/Natijani aniqlab bo‘lmadi/)).toBeInTheDocument();
      expect(screen.queryByText(/Avvalgi so‘rov bajarilmagan/)).toBeNull();
      expect(restart).not.toHaveBeenCalled();
      expect(pendingAction(action)).toMatchObject({ key, unknown: true });
      expect(submitButton()).toBeDisabled();
      // The void may be asked again with the same key; only its own VOIDED gives a new key.
      fireEvent.click(screen.getByRole('button', { name: RESOLVE }));
      await vi.waitFor(() => expect(pendingAction(action)?.key).not.toBe(key));
      expect(voidKey).toHaveBeenNthCalledWith(2, expect.objectContaining({ idempotencyKey: key }));
    },
  );

  it('a 409 (the key voided in another tab) shows the existing conflict text and the void', async () => {
    seq += 1;
    const action = adminActionId(me.admin.id, 'payments.reverse', `outcome_${seq}`);
    const submit = vi.fn(() =>
      Promise.reject(new ApiError({ status: 409, code: 'IDEMPOTENCY_CONFLICT', fromServer: true })),
    );
    renderDialog(action, submit);
    fireEvent.change(screen.getByRole('textbox', { name: /Sabab/ }), {
      target: { value: 'Pul bank orqali qaytdi' },
    });
    fireEvent.click(submitButton());
    expect(
      await screen.findByText(/kalit avval ishlatilgan yoki bekor qilingan/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: RESOLVE })).toBeEnabled();
    expect(submitButton()).toBeDisabled();
  });

  it('two clicks in one tick send one void', async () => {
    const { action } = unknownAction();
    let settle: (value: AdminWriteKeyVoidResponse) => void = () => undefined;
    voidKey.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    renderDialog(action);
    const button = screen.getByRole('button', { name: RESOLVE });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(voidKey).toHaveBeenCalledTimes(1);
    await act(async () => {
      settle({ status: 'VOIDED', auditId: `a${'0'.repeat(31)}`, at: AT });
      await Promise.resolve();
    });
  });
});
