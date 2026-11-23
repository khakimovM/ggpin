import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { Undo2 } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { adminActionId, pendingAction } from '../../../lib/idempotency';
import { renderAdmin } from '../../../test/render';
import { ReasonDialog, type ReasonSubmit } from '../ReasonDialog';

const ADMIN_ID = 'cmadminowner01';
let seq = 0;

function renderDialog(onSubmit: (input: ReasonSubmit) => Promise<void>) {
  seq += 1;
  const action = adminActionId(ADMIN_ID, 'payments.reverse', `double_${seq}`);
  renderAdmin(
    <ReasonDialog
      action={action}
      open
      onOpenChange={() => {}}
      title="Qaytarish"
      icon={Undo2}
      submitLabel="Qaytarish"
      actor={{ name: 'Aziz O.', role: 'OWNER' }}
      onSubmit={onSubmit}
    />,
  );
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Pul bank orqali qaytdi' } });
  return action;
}

describe('ReasonDialog submit guard', () => {
  it('two submits in one tick send one request (synchronous ref guard)', async () => {
    let release: () => void = () => {};
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    renderDialog(onSubmit);
    const form = screen.getByRole('button', { name: 'Qaytarish' }).closest('form');
    if (form === null) throw new Error('no form');
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(() => {
      release();
      return Promise.resolve();
    });
  });

  it('asks before leaving while a request is out: returnValue is an empty string (I-2)', async () => {
    let release: () => void = () => {};
    renderDialog(() => new Promise<void>((resolve) => (release = resolve)));
    fireEvent.click(screen.getByRole('button', { name: 'Qaytarish' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Qaytarish/ })).toHaveAttribute(
        'aria-busy',
        'true',
      ),
    );
    const event = new Event('beforeunload', { cancelable: true });
    Object.defineProperty(event, 'returnValue', { value: 'x', writable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect((event as Event & { returnValue: unknown }).returnValue).toBe('');
    await act(() => {
      release();
      return Promise.resolve();
    });
  });

  it('CODE_EXPIRED after a submit is an unknown outcome: the key is kept (SA-S6-7)', async () => {
    const action = renderDialog(() =>
      Promise.reject(new ApiError({ status: 422, code: 'CODE_EXPIRED', fromServer: true })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Qaytarish' }));
    await screen.findByRole('status');
    expect(pendingAction(action)).toMatchObject({ unknown: true, conflict: false });
  });

  it('a plain refusal is not unknown and keeps the key for the next attempt', async () => {
    const action = renderDialog(() =>
      Promise.reject(
        new ApiError({
          status: 400,
          code: 'VALIDATION_ERROR',
          fromServer: true,
          details: { fields: [{ path: 'paymentStatus', code: 'ALREADY_REVERSED' }] },
        }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Qaytarish' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Bu to‘lov allaqachon qaytarilgan');
    expect(pendingAction(action)).toMatchObject({ unknown: false });
  });
});
