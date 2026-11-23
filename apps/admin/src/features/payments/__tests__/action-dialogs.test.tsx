// Flags that appear only after an API refusal (PauseResume, ReverseOpen) and ticks bound to the
// target they were given for (CR-1 review credit). The API modules are faked; the dialogs are real.
import { AdminCreditPreviewResponseSchema, type AdminReviewDetailResponse } from '@repo/shared';
import { fireEvent, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminContext } from '../../../app/admin-context';
import { ApiError } from '../../../lib/api/errors';
import { meFixture } from '../../../lib/api/mock/fixtures';
import { CARDS, PAYMENTS } from '../../../lib/api/mock/fixtures-payments';
import { changeCard, getCreditPreview, reversePayment } from '../../../lib/api/writes-payments';
import { renderAdmin } from '../../../test/render';
import { CardPauseResumeDialog } from '../CardPauseResumeDialog';
import { ReversePaymentDialog } from '../ReversePaymentDialog';
import { ReviewCreditDialog } from '../ReviewCreditDialog';

vi.mock('../../../lib/api/writes-payments', () => ({
  changeCard: vi.fn(),
  creditReview: vi.fn(),
  getCreditPreview: vi.fn(),
  reversePayment: vi.fn(),
}));
vi.mock('../../../lib/api/confirmations', () => ({ requestConfirmation: vi.fn() }));

const REASON = 'Bank xabari qo‘lda tekshirildi';

function asOwner(ui: ReactNode) {
  return renderAdmin(
    <MemoryRouter>
      <AdminContext.Provider value={meFixture('OWNER', new Date('2026-11-17T09:00:00Z'))}>
        {ui}
      </AdminContext.Provider>
    </MemoryRouter>,
  );
}

function refusal(code: string, path = 'action') {
  return new ApiError({
    status: 422,
    code: 'VALIDATION_ERROR',
    details: { fields: [{ path, code }] },
  });
}

function sendWithReason(cta: string) {
  fireEvent.change(screen.getByRole('textbox', { name: /Sabab/ }), { target: { value: REASON } });
  fireEvent.click(screen.getByRole('button', { name: cta }));
}

afterEach(() => {
  vi.mocked(changeCard).mockReset();
  vi.mocked(reversePayment).mockReset();
  vi.mocked(getCreditPreview).mockReset();
});

describe('card resume: what the API names appears only after its refusal', () => {
  const card = CARDS[1] ?? CARDS[0];
  if (card === undefined) throw new Error('fixture');

  it('SECURITY_PAUSE_OPEN shows its checkbox; ticking it opens the code step', async () => {
    vi.mocked(changeCard).mockRejectedValueOnce(refusal('SECURITY_PAUSE_OPEN'));
    asOwner(<CardPauseResumeDialog kind="cards.resume" card={card} open onOpenChange={vi.fn()} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    sendWithReason('Davom ettirish');
    const security = await screen.findByRole('checkbox', { name: /Xavfsizlik pauzasini/ });
    expect(screen.queryByRole('button', { name: 'Kodni olish' })).toBeNull();
    fireEvent.click(security);
    expect(screen.getByRole('button', { name: 'Kodni olish' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Davom ettirish' })).toBeDisabled();
  });

  it('OPEN_PAUSE_REVIEWS shows "resume anyway"; the send stays closed until it is ticked', async () => {
    vi.mocked(changeCard).mockRejectedValueOnce(refusal('OPEN_PAUSE_REVIEWS'));
    asOwner(<CardPauseResumeDialog kind="cards.resume" card={card} open onOpenChange={vi.fn()} />);
    sendWithReason('Davom ettirish');
    const override = await screen.findByRole('checkbox', { name: /baribir davom ettirish/ });
    expect(screen.getByRole('button', { name: 'Davom ettirish' })).toBeDisabled();
    fireEvent.click(override);
    expect(screen.getByRole('button', { name: 'Davom ettirish' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Kodni olish' })).toBeNull();
  });
});

describe('payment reverse below the threshold', () => {
  const small = PAYMENTS.find((payment) => BigInt(payment.amountTiyin) <= 10_000_000n);
  if (small === undefined) throw new Error('fixture');

  it('OTP_REQUIRED (daily budget used up) asks for the re-typed amount and the code', async () => {
    vi.mocked(reversePayment).mockRejectedValueOnce(refusal('OTP_REQUIRED'));
    asOwner(<ReversePaymentDialog payment={small} open onOpenChange={vi.fn()} />);
    expect(screen.queryByRole('textbox', { name: 'Summani qayta kiriting' })).toBeNull();
    sendWithReason('Qaytarish');
    expect(
      await screen.findByRole('textbox', { name: 'Summani qayta kiriting' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Qaytarish' })).toBeDisabled();
  });
});

describe('review credit: the ticks belong to one target (CR-1)', () => {
  const review = {
    id: 'mkrev000002',
    intentId: 'mkint000005',
    amountTiyin: '7500000',
  } as AdminReviewDetailResponse;
  const preview = AdminCreditPreviewResponseSchema.parse({
    amountTiyin: '7500000',
    userId: 'mkuser000001',
    blocked: true,
    purchaseFrozen: false,
    accountAgeDays: 412,
    overLimit: false,
    overrideNeeded: 'USER_BLOCKED',
    needsBankVerification: true,
    manualCreditsSinceRequest: {
      adjust: { count: 0, sumTiyin: '0' },
      reviewCredit: { count: 0, sumTiyin: '0' },
      since: '2026-11-17T08:00:00.000Z',
    },
  });

  it('another request id clears the override and bank-verified ticks', async () => {
    vi.mocked(getCreditPreview).mockResolvedValue(preview);
    asOwner(<ReviewCreditDialog review={review} open onOpenChange={vi.fn()} />);
    const override = await screen.findByRole('checkbox', { name: /Baribir hisoblash/ });
    const bank = screen.getByRole('checkbox', { name: /bankda kelganini/ });
    fireEvent.click(override);
    fireEvent.click(bank);
    expect(override).toBeChecked();
    expect(bank).toBeChecked();
    fireEvent.change(screen.getByRole('textbox', { name: 'So‘rov ID' }), {
      target: { value: 'mkint000006' },
    });
    const again = await screen.findByRole('checkbox', { name: /Baribir hisoblash/ });
    expect(again).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /bankda kelganini/ })).not.toBeChecked();
  });
});
