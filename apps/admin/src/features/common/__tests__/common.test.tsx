import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { renderAdmin } from '../../../test/render';
import { ConfirmCodeStep, confirmProblemOf, type ConfirmCodeProblem } from '../ConfirmCodeStep';
import { ForbiddenState } from '../ForbiddenState';

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

/** A parent that keeps the last refusal and, like an old caller, never clears it itself. */
function StaleParent({ onCodeRequested }: { onCodeRequested: () => void }) {
  const [problem, setProblem] = useState<ConfirmCodeProblem | null>(null);
  const requestCode = () => Promise.resolve({ challengeId: 'b'.repeat(32), expiresInSec: 180 });
  return (
    <>
      <button type="button" onClick={() => setProblem({ kind: 'locked' })}>
        bloklash
      </button>
      <ConfirmCodeStep
        requestCode={requestCode}
        onChange={vi.fn()}
        problem={problem}
        onCodeRequested={onCodeRequested}
      />
    </>
  );
}

describe('ConfirmCodeStep', () => {
  it('shows the boxes again after a new code, even if the parent keeps the old refusal', async () => {
    const user = userEvent.setup();
    const onCodeRequested = vi.fn();
    renderAdmin(<StaleParent onCodeRequested={onCodeRequested} />);
    const timer = /amal qiladi/;
    await user.click(screen.getByRole('button', { name: 'Kodni olish' }));
    expect(await screen.findByText(timer)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'bloklash' }));
    expect(screen.queryByText(timer)).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Urinishlar tugadi');
    await user.click(screen.getByRole('button', { name: 'Yangi kod olish' }));
    expect(await screen.findByText(timer)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onCodeRequested).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: 'bloklash' }));
    expect(screen.queryByText(timer)).not.toBeInTheDocument();
  });

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
