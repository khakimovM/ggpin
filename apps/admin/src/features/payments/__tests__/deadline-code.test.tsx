// docs/04 «So‘rov deadline’i» on a coded action (9B-3): a 503 ADMIN_DEADLINE_EXCEEDED may come
// after the code was spent, so the panel keeps the key, clears the code and asks for a new one; the
// resend goes with the SAME key. A proxy 503 stays an unknown outcome instead.
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminContext } from '../../../app/admin-context';
import { requestConfirmation } from '../../../lib/api/confirmations';
import { ApiError, isDeadlineExceeded, isOutcomeUnknown } from '../../../lib/api/errors';
import { meFixture } from '../../../lib/api/mock/fixtures';
import { CARDS } from '../../../lib/api/mock/fixtures-payments';
import { changeCard } from '../../../lib/api/writes-payments';
import { renderAdmin } from '../../../test/render';
import { confirmProblemOf } from '../../common/ConfirmCodeStep';
import { CardRetireDialog } from '../CardRetireDialog';

vi.mock('../../../lib/api/writes-payments', () => ({ changeCard: vi.fn() }));
vi.mock('../../../lib/api/confirmations', () => ({ requestConfirmation: vi.fn() }));

const deadline = () =>
  new ApiError({ status: 503, code: 'ADMIN_DEADLINE_EXCEEDED', fromServer: true });

afterEach(() => {
  vi.mocked(changeCard).mockReset();
  vi.mocked(requestConfirmation).mockReset();
  window.sessionStorage.clear();
});

describe('a deadline 503 on a coded action', { timeout: 30_000 }, () => {
  it('the code under another status is not the deadline answer: never "nothing written" (CR-5)', () => {
    for (const status of [500, 502, 504, 400, 409]) {
      const odd = new ApiError({ status, code: 'ADMIN_DEADLINE_EXCEEDED', fromServer: true });
      expect(isDeadlineExceeded(odd)).toBe(false);
      expect(confirmProblemOf(odd)).toBeNull();
    }
    expect(
      isOutcomeUnknown(
        new ApiError({ status: 500, code: 'ADMIN_DEADLINE_EXCEEDED', fromServer: true }),
      ),
    ).toBe(true);
  });

  it('reads as "deadline" only in the API envelope', () => {
    expect(confirmProblemOf(deadline())).toEqual({ kind: 'deadline' });
    expect(
      confirmProblemOf(new ApiError({ status: 503, code: 'ADMIN_DEADLINE_EXCEEDED' })),
    ).toBeNull();
  });

  it('keeps the key, clears the code, asks for a new one; the resend has the same key', async () => {
    const user = userEvent.setup();
    const card = CARDS[0];
    if (card === undefined) throw new Error('fixture');
    let deliver: () => void = () => undefined;
    vi.mocked(requestConfirmation)
      .mockResolvedValueOnce({ challengeId: 'c'.repeat(32), expiresInSec: 180 })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            deliver = () => resolve({ challengeId: 'd'.repeat(32), expiresInSec: 180 });
          }),
      );
    vi.mocked(changeCard)
      .mockRejectedValueOnce(deadline())
      // The resend is refused for another reason: only its key matters here.
      .mockRejectedValueOnce(
        new ApiError({ status: 400, code: 'VALIDATION_ERROR', fromServer: true }),
      );
    renderAdmin(
      <MemoryRouter>
        <AdminContext.Provider value={meFixture('OWNER', new Date('2026-11-24T09:00:00Z'))}>
          <CardRetireDialog card={card} open onOpenChange={vi.fn()} />
        </AdminContext.Provider>
      </MemoryRouter>,
    );
    await user.type(screen.getByRole('textbox', { name: /Sabab/ }), 'Karta yopildi, yangisi bor');
    await user.click(screen.getByRole('button', { name: 'Kodni olish' }));
    await user.click(await screen.findByRole('textbox', { name: 'Kod, 1-raqam' }));
    await user.keyboard('123456');
    const send = screen.getByRole('button', { name: 'Chiqarish' });
    await user.click(send);
    expect(await screen.findByText(/Yangi kod oling va qayta yuboring/)).toBeInTheDocument();
    // CR-6: one alert (the form's, "nothing written"); the code box only says what to do.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent(/hech narsa yozilmadi/);
    expect(screen.queryByRole('textbox', { name: 'Kod, 1-raqam' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Natijani aniqlash' })).toBeNull();
    expect(send).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Yangi kod olish' }));
    // While the new code is on its way the old challenge is not offered: an answer typed there
    // would go out with the spent challenge id.
    expect(screen.queryByRole('textbox', { name: 'Kod, 1-raqam' })).toBeNull();
    act(() => deliver());
    await user.click(await screen.findByRole('textbox', { name: 'Kod, 1-raqam' }));
    await user.keyboard('123456');
    await user.click(send);
    await waitFor(() => expect(changeCard).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(changeCard).mock.calls;
    expect(calls[1]?.[2]).toBe(calls[0]?.[2]);
    expect(calls[1]?.[1].body).toMatchObject({ otp: { challengeId: 'd'.repeat(32) } });
  });

  it('a failed new-code request (429) never revives the spent challenge (CR-8)', async () => {
    const user = userEvent.setup();
    const card = CARDS[0];
    if (card === undefined) throw new Error('fixture');
    vi.mocked(requestConfirmation)
      .mockResolvedValueOnce({ challengeId: 'c'.repeat(32), expiresInSec: 180 })
      .mockRejectedValueOnce(new ApiError({ status: 429, code: 'RATE_LIMITED', fromServer: true }))
      .mockResolvedValueOnce({ challengeId: 'e'.repeat(32), expiresInSec: 180 });
    vi.mocked(changeCard)
      .mockRejectedValueOnce(deadline())
      .mockRejectedValueOnce(
        new ApiError({ status: 400, code: 'VALIDATION_ERROR', fromServer: true }),
      );
    renderAdmin(
      <MemoryRouter>
        <AdminContext.Provider value={meFixture('OWNER', new Date('2026-11-24T09:00:00Z'))}>
          <CardRetireDialog card={card} open onOpenChange={vi.fn()} />
        </AdminContext.Provider>
      </MemoryRouter>,
    );
    await user.type(screen.getByRole('textbox', { name: /Sabab/ }), 'Karta yopildi, yangisi bor');
    await user.click(screen.getByRole('button', { name: 'Kodni olish' }));
    await user.click(await screen.findByRole('textbox', { name: 'Kod, 1-raqam' }));
    await user.keyboard('123456');
    const send = screen.getByRole('button', { name: 'Chiqarish' });
    await user.click(send);
    await user.click(await screen.findByRole('button', { name: 'Yangi kod olish' }));
    // The request is refused: the old (maybe spent) challenge is not offered again.
    expect(await screen.findByText(/Kodlar juda ko‘p so‘raldi/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Kod, 1-raqam' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Yangi kod olish' })).toBeInTheDocument();
    expect(send).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Yangi kod olish' }));
    await user.click(await screen.findByRole('textbox', { name: 'Kod, 1-raqam' }));
    await user.keyboard('123456');
    await user.click(send);
    await waitFor(() => expect(changeCard).toHaveBeenCalledTimes(2));
    expect(vi.mocked(changeCard).mock.calls[1]?.[1].body).toMatchObject({
      otp: { challengeId: 'e'.repeat(32) },
    });
  });
});
