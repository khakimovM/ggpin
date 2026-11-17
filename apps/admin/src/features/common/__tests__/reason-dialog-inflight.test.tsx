import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Undo2 } from 'lucide-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { adminActionId, type AdminActionId } from '../../../lib/idempotency';
import { renderAdmin } from '../../../test/render';
import { ReasonDialog, type ReasonSubmit } from '../ReasonDialog';

type Submit = (input: ReasonSubmit) => Promise<void>;
const ADMIN_ID = 'cmadminowner01';
const STORAGE_KEY = 'ggpin-admin-pending-actions';

let seq = 0;
function nextAction(): { action: AdminActionId; targetId: string } {
  seq += 1;
  const targetId = `inflight_${seq}`;
  return { action: adminActionId(ADMIN_ID, 'orders.refund', targetId), targetId };
}

/** onSubmit that stays pending until the test settles it. */
function pendingSubmit() {
  const handle: { resolve: () => void; reject: (error: unknown) => void } = {
    resolve: () => undefined,
    reject: () => undefined,
  };
  const onSubmit = vi.fn<Submit>(
    () =>
      new Promise<void>((resolve, reject) => {
        handle.resolve = resolve;
        handle.reject = reject;
      }),
  );
  return { onSubmit, handle };
}

function dialog(action: AdminActionId, onSubmit: Submit) {
  return renderAdmin(
    <ReasonDialog
      action={action}
      open
      onOpenChange={vi.fn()}
      title="Pulni qaytarish"
      icon={Undo2}
      tone="danger"
      submitLabel="Qaytarish"
      actor={{ name: 'Aziz O.', role: 'OWNER' }}
      onSubmit={onSubmit}
    />,
  );
}

async function startSending(onSubmit: ReturnType<typeof vi.fn<Submit>>) {
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: /Sabab/ }), 'Mijoz so‘rovi bilan');
  await user.click(screen.getByRole('button', { name: 'Qaytarish' }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  return onSubmit.mock.calls[0]?.[0].idempotencyKey;
}

/** True when a `beforeunload` listener asked the browser to confirm leaving. */
function leavingAsks(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('ReasonDialog while the request is out (SA M-2)', () => {
  it('writes the key ahead, so a reload mid-flight brings it back as unknown', async () => {
    const { action, targetId } = nextAction();
    const { onSubmit } = pendingSubmit();
    dialog(action, onSubmit);
    const key = await startSending(onSubmit);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toContain(`"key":"${key}"`);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).not.toContain('Mijoz');

    vi.resetModules();
    const reloaded = await import('../../../lib/idempotency');
    expect(
      reloaded.pendingAction(reloaded.adminActionId(ADMIN_ID, 'orders.refund', targetId)),
    ).toEqual({ key, reason: null, unknown: true, conflict: false });
  });

  it('asks before leaving the page only while the request is out', async () => {
    const { action } = nextAction();
    const { onSubmit, handle } = pendingSubmit();
    dialog(action, onSubmit);
    expect(leavingAsks()).toBe(false);
    await startSending(onSubmit);
    expect(leavingAsks()).toBe(true);
    handle.reject(new ApiError({ status: 422, code: 'CODE_INVALID', fromServer: true }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    // The listener goes in a passive-effect cleanup, which React may run just after the commit
    // that shows the alert; wait for it rather than assume it ran in the same tick.
    await waitFor(() => expect(leavingAsks()).toBe(false));
  });

  it('stops asking when the dialog unmounts mid-flight', async () => {
    const { action } = nextAction();
    const { onSubmit } = pendingSubmit();
    const view = dialog(action, onSubmit);
    await startSending(onSubmit);
    expect(leavingAsks()).toBe(true);
    view.unmount();
    expect(leavingAsks()).toBe(false);
  });
});
