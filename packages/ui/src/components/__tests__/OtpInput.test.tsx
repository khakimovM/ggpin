import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OtpInput } from '../OtpInput';

function Harness({
  onComplete,
  error,
  errorKey,
  initial = '',
}: {
  onComplete?: (code: string) => void;
  error?: boolean;
  errorKey?: number;
  initial?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <OtpInput
      value={value}
      onChange={setValue}
      onComplete={onComplete}
      error={error}
      errorKey={errorKey}
      errorMessage="Kod noto‘g‘ri"
      label="Tasdiqlash kodi"
      boxLabel={(position) => `Kod, ${position}-raqam`}
    />
  );
}

const box = (position: number) => screen.getByLabelText(`Kod, ${position}-raqam`);

describe('OtpInput', () => {
  it('renders six boxes in a labelled group', () => {
    render(<Harness />);
    expect(screen.getByRole('group', { name: 'Tasdiqlash kodi' })).toBeInTheDocument();
    for (let position = 1; position <= 6; position += 1) expect(box(position)).toBeInTheDocument();
  });

  it('pasting six digits fills every box and calls onComplete exactly once', () => {
    const onComplete = vi.fn();
    render(<Harness onComplete={onComplete} />);
    fireEvent.paste(box(1), { clipboardData: { getData: () => '482913' } });
    for (const [index, digit] of ['4', '8', '2', '9', '1', '3'].entries()) {
      expect(box(index + 1)).toHaveValue(digit);
    }
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith('482913');
  });

  it('ignores non-digits when pasting', () => {
    const onComplete = vi.fn();
    render(<Harness onComplete={onComplete} />);
    fireEvent.paste(box(1), { clipboardData: { getData: () => ' 48-29 13 ' } });
    expect(box(6)).toHaveValue('3');
    expect(onComplete).toHaveBeenCalledWith('482913');
  });

  it('typing moves focus forward and completes once on the last digit', async () => {
    const onComplete = vi.fn();
    render(<Harness onComplete={onComplete} />);
    await userEvent.click(box(1));
    await userEvent.keyboard('12345');
    expect(onComplete).not.toHaveBeenCalled();
    expect(box(6)).toHaveFocus();
    await userEvent.keyboard('6');
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith('123456');
  });

  it('does not accept letters', async () => {
    render(<Harness />);
    await userEvent.click(box(1));
    await userEvent.keyboard('ab');
    expect(box(1)).toHaveValue('');
  });

  it('Backspace on an empty box clears the previous digit and moves back', async () => {
    render(<Harness initial="12" />);
    await userEvent.click(box(3));
    await userEvent.keyboard('{Backspace}');
    expect(box(2)).toHaveValue('');
    expect(box(2)).toHaveFocus();
    expect(box(1)).toHaveValue('1');
  });

  it('marks the boxes invalid on error', () => {
    render(<Harness error initial="123456" />);
    expect(box(1)).toHaveAttribute('aria-invalid', 'true');
  });

  it('clears a box when its content is removed (cut, select + delete)', () => {
    render(<Harness initial="123456" />);
    fireEvent.change(box(3), { target: { value: '' } });
    expect(box(3)).toHaveValue('4');
    expect(box(1)).toHaveValue('1');
    expect(box(5)).toHaveValue('6');
  });

  it('a soft-keyboard Backspace (beforeinput) in an empty box clears the previous digit', () => {
    render(<Harness initial="12" />);
    box(3).focus();
    const event = new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      box(3).dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(box(2)).toHaveValue('');
    expect(box(2)).toHaveFocus();
  });

  it('ties the error message to every box with aria-describedby', () => {
    render(<Harness error initial="123456" />);
    const message = screen.getByRole('alert');
    expect(message).toHaveTextContent('Kod noto‘g‘ri');
    expect(box(1)).toHaveAccessibleDescription('Kod noto‘g‘ri');
    expect(box(6)).toHaveAccessibleDescription('Kod noto‘g‘ri');
  });

  it('shows no message and no description without an error', () => {
    render(<Harness initial="123456" />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(box(1)).not.toHaveAttribute('aria-describedby');
  });

  describe('shake', () => {
    afterEach(() => {
      Reflect.deleteProperty(Element.prototype, 'animate');
    });

    it('plays on error, again on every new failed attempt, never under reduced motion', () => {
      const animate = vi.fn();
      Object.defineProperty(Element.prototype, 'animate', { value: animate, configurable: true });
      const { rerender } = render(<Harness error errorKey={1} />);
      expect(animate).toHaveBeenCalledTimes(1);
      rerender(<Harness error errorKey={2} />);
      expect(animate).toHaveBeenCalledTimes(2);
      rerender(<Harness error errorKey={2} />);
      expect(animate).toHaveBeenCalledTimes(2);
    });

    it('is skipped when reduced motion is on', () => {
      const animate = vi.fn();
      Object.defineProperty(Element.prototype, 'animate', { value: animate, configurable: true });
      document.documentElement.dataset.reduced = 'true';
      render(<Harness error errorKey={1} />);
      expect(animate).not.toHaveBeenCalled();
    });
  });
});
