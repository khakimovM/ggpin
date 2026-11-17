import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Undo2 } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { renderAdmin } from '../../../test/render';
import { ConfirmCodeStep, confirmProblemOf } from '../ConfirmCodeStep';
import { ForbiddenState } from '../ForbiddenState';
import { ReasonDialog, type ReasonSubmit } from '../ReasonDialog';

function dialog(onSubmit: (input: ReasonSubmit) => Promise<void>, onOpenChange = vi.fn()) {
  return renderAdmin(
    <ReasonDialog
      open
      onOpenChange={onOpenChange}
      title="Buyurtmani bekor qilish"
      icon={Undo2}
      tone="danger"
      submitLabel="Bekor qilish"
      actor={{ name: 'Aziz O.', role: 'OWNER' }}
      onSubmit={onSubmit}
    />,
  );
}

describe('ReasonDialog', () => {
  it('is an accessible dialog with the audit line', () => {
    dialog(vi.fn());
    expect(screen.getByRole('dialog', { name: 'Buyurtmani bekor qilish' })).toBeInTheDocument();
    expect(screen.getByText('Bu amal audit logga yoziladi · Aziz O. (OWNER)')).toBeInTheDocument();
  });

  it('keeps the action disabled until the reason has 10 characters', async () => {
    const user = userEvent.setup();
    dialog(vi.fn());
    const submit = screen.getByRole('button', { name: 'Bekor qilish' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: /Sabab/ }), 'qisqa');
    await user.tab();
    expect(screen.getByText('Sabab kamida 10 ta belgidan iborat bo‘lsin')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: /Sabab/ }), ' sabab matni');
    expect(submit).toBeEnabled();
  });

  it('keeps one Idempotency-Key across retries and shows the API error', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onSubmit = vi
      .fn<(input: ReasonSubmit) => Promise<void>>()
      .mockRejectedValueOnce(new ApiError({ status: 409, code: 'ORDER_STATE_CONFLICT' }))
      .mockResolvedValueOnce(undefined);
    dialog(onSubmit, onOpenChange);
    await user.type(screen.getByRole('textbox', { name: /Sabab/ }), '  Mijoz so‘rovi bilan  ');
    await user.click(screen.getByRole('button', { name: 'Bekor qilish' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Bekor qilish' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const [first, second] = onSubmit.mock.calls.map(([input]) => input);
    expect(first?.reason).toBe('Mijoz so‘rovi bilan');
    expect(first?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
  });
});

describe('ForbiddenState', () => {
  it('names the roles that may open the section and the current role', () => {
    renderAdmin(<ForbiddenState allowed={['OWNER']} role="SUPPORT" />);
    expect(
      screen.getByRole('heading', { name: 'Bu bo‘lim faqat OWNER uchun' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Sizning rolingiz: SUPPORT')).toBeInTheDocument();
  });

  it('joins several roles the Uzbek way, in matrix order', () => {
    renderAdmin(<ForbiddenState allowed={['OPERATOR', 'OWNER']} role="SUPPORT" />);
    expect(screen.getByRole('heading').textContent).toMatch(
      /^Bu bo‘lim faqat OWNER .+ OPERATOR uchun$/,
    );
  });
});

describe('ConfirmCodeStep', () => {
  it('requests a code, then reports the answer once six digits are in', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const requestCode = vi
      .fn()
      .mockResolvedValue({ challengeId: 'a'.repeat(32), expiresInSec: 180 });
    renderAdmin(<ConfirmCodeStep requestCode={requestCode} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Kodni olish' }));
    expect(
      await screen.findByText(/Kod 3:00 amal qiladi|Kod 2:5\d amal qiladi/),
    ).toBeInTheDocument();
    await user.keyboard('123456');
    expect(onChange).toHaveBeenLastCalledWith({ challengeId: 'a'.repeat(32), code: '123456' });
  });

  it('explains why the code could not be sent', async () => {
    const user = userEvent.setup();
    const requestCode = vi.fn().mockRejectedValue(
      new ApiError({
        status: 400,
        code: 'VALIDATION_ERROR',
        details: { fields: [{ path: 'otp', code: 'OTP_UNAVAILABLE' }] },
      }),
    );
    renderAdmin(<ConfirmCodeStep requestCode={requestCode} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Kodni olish' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Botni bloklamaganingizni');
  });

  it('reads the code refusals of an action', () => {
    const wrong = new ApiError({ status: 422, code: 'CODE_INVALID', details: { attemptsLeft: 2 } });
    expect(confirmProblemOf(wrong)).toEqual({ kind: 'wrong', attemptsLeft: 2 });
    const locked = new ApiError({
      status: 400,
      code: 'VALIDATION_ERROR',
      details: { fields: [{ path: 'otp', code: 'OTP_LOCKED' }] },
    });
    expect(confirmProblemOf(locked)).toEqual({ kind: 'locked' });
    expect(confirmProblemOf(new ApiError({ status: 422, code: 'CODE_EXPIRED' }))).toEqual({
      kind: 'expired',
    });
    expect(confirmProblemOf(new ApiError({ status: 500, code: 'INTERNAL_ERROR' }))).toBeNull();
  });
});
