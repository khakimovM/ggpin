// The form's lock, through the real submit path (9B-3 fix round): how each answer is classified
// (CR-3), a refusal for an older attempt never clears "unknown" (SA M-1R), no second attempt
// while one is out — also after closing and reopening (CR-2) —, and an unknown opposite action
// on the same target locks this one until its own key void settles it (SA L-2).
import type { AdminWriteKeyVoidBody } from '@repo/shared';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Undo2 } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { voidWriteKey } from '../../../lib/api/writes-keys';
import {
  adminActionId,
  beginAttempt,
  markActionOutcomeUnknown,
  endRefusedAttempt,
  pendingAction,
  pendingInFlight,
  type AdminActionId,
} from '../../../lib/idempotency';
import type { AppliedOutcome } from '../../../lib/idempotency-outcome';
import { OPPOSITE_ACTIONS, oppositeOf } from '../../../lib/opposite-actions';
import { renderAdmin } from '../../../test/render';
import { voidAnswer } from '../../../test/void-answer';
import { ReasonDialog, type ReasonSubmit } from '../ReasonDialog';

vi.mock('../../../lib/api/writes-keys', () => ({ voidWriteKey: vi.fn() }));

type Submit = (input: ReasonSubmit) => Promise<void>;
const ADMIN_ID = 'cmadminowner01';
const REASON = 'Mijoz so‘rovi bilan';
const UNKNOWN_TEXT = /Natija nomaʼlum/;
const CONFLICT_TEXT = /kalit avval ishlatilgan yoki bekor qilingan/;
const RESOLVE = 'Natijani aniqlash';
let seq = 0;

function nextAction(): AdminActionId {
  seq += 1;
  return adminActionId(ADMIN_ID, 'users.adjustWallet', `lock_${seq}`);
}

interface Hooks {
  onOpenChange?: (open: boolean) => void;
  onOutcomeFound?: (applied: AppliedOutcome) => void;
}

function dialog(action: AdminActionId, onSubmit: Submit, cta = 'Tuzatish', hooks: Hooks = {}) {
  return renderAdmin(
    <ReasonDialog
      action={action}
      open
      onOpenChange={hooks.onOpenChange ?? vi.fn()}
      {...(hooks.onOutcomeFound === undefined ? {} : { onOutcomeFound: hooks.onOutcomeFound })}
      title="Amal"
      icon={Undo2}
      submitLabel={cta}
      actor={{ name: 'Aziz O.', role: 'OWNER' }}
      onSubmit={onSubmit}
    />,
  );
}

const sendButton = (cta = 'Tuzatish') => screen.getByRole('button', { name: cta });
const refusal = (status: number, code: ConstructorParameters<typeof ApiError>[0]['code']) =>
  new ApiError({ status, code, fromServer: true });

afterEach(() => {
  vi.mocked(voidWriteKey).mockReset();
});

describe('the form classifies each answer itself (CR-3)', { timeout: 30_000 }, () => {
  it('409 IDEMPOTENCY_CONFLICT: unknown with the conflict flag; the existing text; locked', async () => {
    const user = userEvent.setup();
    const action = nextAction();
    const onSubmit = vi.fn<Submit>().mockRejectedValue(refusal(409, 'IDEMPOTENCY_CONFLICT'));
    dialog(action, onSubmit);
    await user.type(screen.getByRole('textbox', { name: /Sabab/ }), REASON);
    await user.click(sendButton());
    // R3-1: one message, announced: the notice with the void is THE alert; no generic one.
    expect(await screen.findByRole('alert')).toHaveTextContent(CONFLICT_TEXT);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByRole('status')).toBeNull();
    const key = onSubmit.mock.calls[0]?.[0].idempotencyKey;
    expect(pendingAction(action)).toMatchObject({ key, unknown: true, conflict: true });
    expect(sendButton()).toBeDisabled();
    // The disabled submit lost the focus: it is on «Natijani aniqlash» now.
    await waitFor(() => expect(screen.getByRole('button', { name: RESOLVE })).toHaveFocus());
  });

  it('no answer (unknown): the focus goes to «Natijani aniqlash»; the error is the one alert', async () => {
    const user = userEvent.setup();
    const action = nextAction();
    const onSubmit = vi
      .fn<Submit>()
      .mockRejectedValue(new ApiError({ status: 0, code: 'NETWORK' }));
    dialog(action, onSubmit);
    await user.type(screen.getByRole('textbox', { name: /Sabab/ }), REASON);
    await user.click(sendButton());
    expect(await screen.findByRole('status')).toHaveTextContent(UNKNOWN_TEXT);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole('button', { name: RESOLVE })).toHaveFocus());
  });

  it('a notice already there when the dialog opens is a quiet status and takes no focus', () => {
    const action = nextAction();
    const { key, attempt } = beginAttempt(action);
    markActionOutcomeUnknown(action, key, { reason: REASON, conflict: true, attempt });
    dialog(action, vi.fn<Submit>());
    expect(screen.getByRole('status')).toHaveTextContent(CONFLICT_TEXT);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: RESOLVE })).not.toHaveFocus();
  });

  it.each([
    ['429', refusal(429, 'RATE_LIMITED')],
    ['400', refusal(400, 'VALIDATION_ERROR')],
    ['404', refusal(404, 'NOT_FOUND')],
  ])('%s: a refusal — the key stays, not unknown, the form open again', async (_s, error) => {
    const user = userEvent.setup();
    const action = nextAction();
    const onSubmit = vi.fn<Submit>().mockRejectedValueOnce(error).mockResolvedValueOnce();
    dialog(action, onSubmit);
    await user.type(screen.getByRole('textbox', { name: /Sabab/ }), REASON);
    await user.click(sendButton());
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
    const key = onSubmit.mock.calls[0]?.[0].idempotencyKey;
    expect(pendingAction(action)).toMatchObject({ key, unknown: false, conflict: false });
    expect(pendingInFlight(action)).toBe(false);
    await user.click(sendButton());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls[1]?.[0].idempotencyKey).toBe(key);
  });

  it('a refusal for an older attempt never clears "unknown" (SA M-1R, real path)', async () => {
    const user = userEvent.setup();
    const action = nextAction();
    let refuse: (error: unknown) => void = () => undefined;
    const onSubmit = vi.fn<Submit>(
      () => new Promise<void>((_resolve, reject) => (refuse = reject)),
    );
    const view = dialog(action, onSubmit);
    await user.type(screen.getByRole('textbox', { name: /Sabab/ }), REASON);
    await user.click(sendButton());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // Meanwhile another attempt of the key (another tab of the same session state) went unknown.
    const later = beginAttempt(action);
    markActionOutcomeUnknown(action, later.key, {
      reason: REASON,
      conflict: false,
      attempt: later.attempt,
    });
    refuse(refusal(429, 'RATE_LIMITED'));
    await waitFor(() => expect(pendingInFlight(action)).toBe(false));
    expect(pendingAction(action)).toMatchObject({ unknown: true });
    view.unmount();
    dialog(action, onSubmit);
    expect(screen.getByRole('status')).toHaveTextContent(UNKNOWN_TEXT);
    expect(sendButton()).toBeDisabled();
  });
});

describe('no second attempt while one is out (CR-2)', { timeout: 30_000 }, () => {
  it('closed and reopened while the request is out: the send is locked, Enter sends nothing', async () => {
    const user = userEvent.setup();
    const action = nextAction();
    const onSubmit = vi.fn<Submit>(() => new Promise<void>(() => undefined));
    const first = dialog(action, onSubmit);
    await user.type(screen.getByRole('textbox', { name: /Sabab/ }), REASON);
    await user.click(sendButton());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    first.unmount();
    dialog(action, onSubmit);
    expect(pendingInFlight(action)).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: /Sabab/ }), { target: { value: REASON } });
    expect(sendButton()).toBeDisabled();
    const form = sendButton().closest('form');
    if (form === null) throw new Error('form');
    fireEvent.submit(form);
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('an unknown opposite action locks this one (SA L-2)', { timeout: 30_000 }, () => {
  it('the table holds exactly the four pairs the owner named', () => {
    expect(
      OPPOSITE_ACTIONS.map((pair) => pair.map((side) => `${side.kind}${side.suffix}`)),
    ).toEqual([
      ['cards.pause', 'cards.resume'],
      ['users.block', 'users.unblock'],
      ['users.freeze', 'users.unfreeze'],
      ['admins.update-deactivate', 'admins.update-reactivate'],
    ]);
  });

  const directions = OPPOSITE_ACTIONS.flatMap((pair) => [
    [pair[0], pair[1]],
    [pair[1], pair[0]],
  ]);

  it.each(directions)('%o unknown locks %o until its void', async (unknownSide, mine) => {
    const user = userEvent.setup();
    seq += 1;
    const record = `rec_${seq}`;
    const theirs = adminActionId(ADMIN_ID, unknownSide.kind, `${record}${unknownSide.suffix}`);
    const action = adminActionId(ADMIN_ID, mine.kind, `${record}${mine.suffix}`);
    expect(oppositeOf(action)?.action).toBe(theirs);
    const { key, attempt } = beginAttempt(theirs);
    markActionOutcomeUnknown(theirs, key, { reason: REASON, conflict: false, attempt });
    vi.mocked(voidWriteKey).mockImplementation((body: AdminWriteKeyVoidBody) =>
      voidAnswer(ADMIN_ID, body, 'VOIDED'),
    );
    const onSubmit = vi.fn<Submit>().mockResolvedValue();
    dialog(action, onSubmit, 'Yuborish');
    await user.type(screen.getByRole('textbox', { name: /Sabab/ }), REASON);
    expect(screen.getByRole('status')).toHaveTextContent(/natijasi nomaʼlum/);
    expect(sendButton('Yuborish')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: RESOLVE }));
    await waitFor(() => expect(sendButton('Yuborish')).toBeEnabled());
    // N-3: its own text, naming the opposite action.
    expect(screen.getByRole('status')).toHaveTextContent(/^Avvalgi «.+» amali bajarilmagan\./);
    expect(vi.mocked(voidWriteKey).mock.calls[0]?.[0]).toMatchObject({
      idempotencyKey: key,
      action: unknownSide.kind,
    });
    expect(pendingAction(theirs)?.unknown).toBe(false);
  });

  function blockPair() {
    seq += 1;
    return {
      theirs: adminActionId(ADMIN_ID, 'users.block', `rec_${seq}`),
      action: adminActionId(ADMIN_ID, 'users.unblock', `rec_${seq}`),
    };
  }

  it('APPLIED for the opposite keeps this dialog open: unlocked, the opposite named (N-2)', async () => {
    const user = userEvent.setup();
    const { theirs, action } = blockPair();
    const { key, attempt } = beginAttempt(theirs);
    markActionOutcomeUnknown(theirs, key, { reason: REASON, conflict: false, attempt });
    vi.mocked(voidWriteKey).mockImplementation((body: AdminWriteKeyVoidBody) =>
      voidAnswer(ADMIN_ID, body, 'APPLIED', 'USER_BLOCK'),
    );
    const onOpenChange = vi.fn();
    const onOutcomeFound = vi.fn();
    dialog(action, vi.fn<Submit>().mockResolvedValue(), 'Yuborish', {
      onOpenChange,
      onOutcomeFound,
    });
    await user.type(screen.getByRole('textbox', { name: /Sabab/ }), REASON);
    await user.click(screen.getByRole('button', { name: RESOLVE }));
    await waitFor(() => expect(sendButton('Yuborish')).toBeEnabled());
    expect(onOutcomeFound).toHaveBeenCalledWith(expect.objectContaining({ action: 'USER_BLOCK' }));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(pendingAction(theirs)).toBeNull();
  });

  it('an opposite still out locks this one, with no void, until its answer (SA L-4)', async () => {
    const user = userEvent.setup();
    const { theirs, action } = blockPair();
    const out = beginAttempt(theirs);
    const onSubmit = vi.fn<Submit>().mockResolvedValue();
    dialog(action, onSubmit, 'Yuborish');
    await user.type(screen.getByRole('textbox', { name: /Sabab/ }), REASON);
    expect(screen.getByRole('status')).toHaveTextContent(/so‘rovi hali yo‘lda/);
    expect(screen.queryByRole('button', { name: RESOLVE })).toBeNull();
    expect(sendButton('Yuborish')).toBeDisabled();
    const form = sendButton('Yuborish').closest('form');
    if (form === null) throw new Error('form');
    fireEvent.submit(form);
    await Promise.resolve();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(vi.mocked(voidWriteKey)).not.toHaveBeenCalled();
    // Its answer came (a refusal): nothing of it can land later, the lock is gone.
    act(() => endRefusedAttempt(theirs, out.key, out.attempt));
    expect(sendButton('Yuborish')).toBeEnabled();
  });

  it('a plain admin change has no opposite; nor do unrelated kinds', () => {
    expect(oppositeOf(adminActionId(ADMIN_ID, 'admins.update', 'cmadmin0001'))).toBeNull();
    expect(oppositeOf(adminActionId(ADMIN_ID, 'users.adjustWallet', 'rec_x'))).toBeNull();
    expect(oppositeOf(adminActionId(ADMIN_ID, 'users.block', 'rec_y'))?.action).toBe(
      adminActionId(ADMIN_ID, 'users.unblock', 'rec_y'),
    );
  });
});
