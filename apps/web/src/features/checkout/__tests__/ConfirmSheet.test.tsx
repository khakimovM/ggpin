import { Star } from 'lucide-react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../auth/__tests__/test-utils';
import { ConfirmSheet, type ConfirmSheetProps, type ConfirmState } from '../ConfirmSheet';

const open = (state: ConfirmState, extra: Partial<ConfirmSheetProps> = {}) => {
  const onOpenChange = vi.fn();
  renderApp(
    <ConfirmSheet
      open
      onOpenChange={onOpenChange}
      state={state}
      nativeAction={false}
      glyph={Star}
      item="Telegram Stars · 50"
      recipient="@aziz_k · Aziz"
      priceTiyin="1100000"
      totalTiyin="1100000"
      balanceTiyin="100000000"
      leftTiyin="98900000"
      msLeft={600_000}
      onPay={vi.fn()}
      onRenew={vi.fn()}
      onContinue={vi.fn()}
      onRetry={vi.fn()}
      {...extra}
    />,
  );
  return onOpenChange;
};

describe('ConfirmSheet: the way to close', () => {
  it('"Bekor qilish" closes a sheet that is ready', async () => {
    const onOpenChange = open('ready');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Bekor qilish' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('positive control: in the ready state Escape closes it (so the two "closes nothing" tests below mean something)', async () => {
    const onOpenChange = open('ready');
    await userEvent.setup().keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('while the payment is on its way "Bekor qilish" is off, and Escape closes nothing', async () => {
    const onOpenChange = open('paying');
    expect(screen.getByRole('button', { name: 'Bekor qilish' })).toBeDisabled();
    await userEvent.setup().keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('the same while an uncertain payment is being checked', async () => {
    const onOpenChange = open('uncertain', { checking: true });
    await userEvent.setup().keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
