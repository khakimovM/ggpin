import type { AdminAuditRow } from '@repo/shared';
import { act, fireEvent, screen } from '@testing-library/react';
import { Undo2 } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminContext } from '../../../app/admin-context';
import { ApiError } from '../../../lib/api/errors';
import { meFixture } from '../../../lib/api/mock/fixtures';
import { listAudit } from '../../../lib/api/people';
import {
  adminActionId,
  beginAttempt,
  markActionOutcomeUnknown,
  pendingAction,
  type AdminActionId,
} from '../../../lib/idempotency';
import { expectedAuditId } from '../../../lib/idempotency-outcome';
import { renderAdmin } from '../../../test/render';
import { ReasonDialog } from '../ReasonDialog';

// N-1 in the dialog: a search made while an attempt of the key is out, or before 60 s have
// passed since the last attempt ENDED, never replaces the key ("start as a new action").
vi.mock('../../../lib/api/people', () => ({ listAudit: vi.fn() }));
const audit = vi.mocked(listAudit);
const me = meFixture('OWNER', new Date('2026-11-17T09:00:00Z'));
const T0 = Date.parse('2026-11-17T09:00:00Z');
const M0 = 1_000;
const CHECK = 'Bajarilganini tekshirish';
const START_NEW = 'Yangi amal sifatida boshlash';
let seq = 0;

function clocksAt(ms: number): void {
  vi.spyOn(Date, 'now').mockReturnValue(T0 + ms);
  vi.spyOn(performance, 'now').mockReturnValue(M0 + ms);
}

/** An action whose first attempt (sent at T0) has an unknown outcome. */
function unknownAction(): { action: AdminActionId; key: string } {
  seq += 1;
  const action = adminActionId(me.admin.id, 'payments.reverse', `n1ui_${seq}`);
  clocksAt(0);
  const { key, attempt } = beginAttempt(action);
  markActionOutcomeUnknown(action, key, {
    reason: 'Pul bank orqali qaytdi',
    conflict: false,
    attempt,
  });
  return { action, key };
}

function renderDialog(action: AdminActionId, submit: () => Promise<void>) {
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

const emptyPage: Awaited<ReturnType<typeof listAudit>> = {
  items: [],
  meta: { page: 1, limit: 100, total: 0 },
};

function auditRow(id: string): AdminAuditRow {
  return {
    id,
    createdAt: new Date(T0).toISOString(),
    actor: { type: 'ADMIN', id: me.admin.id, name: me.admin.name },
    action: 'PAYMENT_REVERSE',
    targetType: 'Payment',
    targetId: 'x',
    before: null,
    after: null,
    reason: null,
    ip: null,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  audit.mockReset();
});

describe('OutcomeCheck while an attempt is out (N-1)', () => {
  it('unknown -> resend hangs -> 61 s later no search -> the resend ends unknown: key stays', async () => {
    const { action, key } = unknownAction();
    audit.mockResolvedValue(emptyPage);
    let fail: (error: unknown) => void = () => undefined;
    const hanging = () =>
      new Promise<void>((_, reject) => {
        fail = reject;
      });
    clocksAt(1_000);
    renderDialog(action, hanging);
    fireEvent.click(screen.getByRole('button', { name: 'Qaytarish' }));
    clocksAt(62_000);
    const check = await screen.findByRole('button', { name: CHECK });
    expect(check).toBeDisabled();
    fireEvent.click(check);
    expect(audit).not.toHaveBeenCalled();
    // The resend ends without an answer (the server may still apply it).
    await act(async () => {
      fail(new ApiError({ status: 0, code: 'NETWORK' }));
      await Promise.resolve();
    });
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: START_NEW })).toBeNull();
    // A search right after the end: not found, but the 60 s count from the end.
    fireEvent.click(screen.getByRole('button', { name: CHECK }));
    expect(await screen.findByText(/soniyadan keyin yana tekshiring/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: START_NEW })).toBeNull();
    expect(pendingAction(action)?.key).toBe(key);
  });

  it('attempt N-1 hangs (a closed dialog), attempt N gets a fast 4xx: no search, key stays', async () => {
    const { action, key } = unknownAction();
    audit.mockResolvedValue(emptyPage);
    beginAttempt(action); // the older attempt: still on its way
    clocksAt(1_000);
    renderDialog(action, () =>
      Promise.reject(new ApiError({ status: 422, code: 'VALIDATION_ERROR', fromServer: true })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Qaytarish' }));
    await screen.findByRole('alert');
    clocksAt(61_000);
    const check = screen.getByRole('button', { name: CHECK });
    expect(check).toBeDisabled();
    fireEvent.click(check);
    expect(audit).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: START_NEW })).toBeNull();
    expect(pendingAction(action)?.key).toBe(key);
  });

  it('the timeout path: 61 s after the send but 31 s after the timeout, no new key', async () => {
    const { action, key } = unknownAction();
    audit.mockResolvedValue(emptyPage);
    clocksAt(1_000);
    // The resend times out after 30 s (WRITE_TIMEOUT_MS): NETWORK, outcome unknown.
    renderDialog(action, () => {
      clocksAt(31_000);
      return Promise.reject(new ApiError({ status: 0, code: 'NETWORK' }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Qaytarish' }));
    await screen.findByRole('alert');
    clocksAt(62_000);
    fireEvent.click(screen.getByRole('button', { name: CHECK }));
    expect(await screen.findByText(/soniyadan keyin yana tekshiring/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: START_NEW })).toBeNull();
    expect(pendingAction(action)?.key).toBe(key);
  });

  it('a row written by the first attempt a day earlier is found: no `from` is sent (SA L-1)', async () => {
    const { action, key } = unknownAction();
    const row = await expectedAuditId(me.admin.id, key);
    audit.mockResolvedValue({
      ...emptyPage,
      items: [auditRow(row)],
      meta: { ...emptyPage.meta, total: 1 },
    });
    // A resend with the same key a day later, again without an answer.
    const day = 25 * 3600_000;
    clocksAt(day);
    const { attempt } = beginAttempt(action);
    markActionOutcomeUnknown(action, key, {
      reason: 'Pul bank orqali qaytdi',
      conflict: false,
      attempt,
    });
    clocksAt(day + 61_000);
    renderDialog(action, () => Promise.resolve());
    fireEvent.click(screen.getByRole('button', { name: CHECK }));
    await vi.waitFor(() => expect(pendingAction(action)).toBeNull());
    expect(audit).toHaveBeenCalledWith(
      expect.not.objectContaining({ from: expect.anything() as unknown }),
    );
  });

  it('the check button wakes up by itself when the attempt out ends elsewhere (F-1)', () => {
    const { action, key } = unknownAction();
    const older = beginAttempt(action); // a closed dialog's request, still on its way
    clocksAt(1_000);
    renderDialog(action, () => Promise.resolve());
    expect(screen.getByRole('button', { name: CHECK })).toBeDisabled();
    // Its answer (a timeout) arrives; nobody touches the dialog.
    act(() => {
      markActionOutcomeUnknown(action, key, {
        reason: 'x',
        conflict: false,
        attempt: older.attempt,
      });
    });
    expect(screen.getByRole('button', { name: CHECK })).toBeEnabled();
  });
});
