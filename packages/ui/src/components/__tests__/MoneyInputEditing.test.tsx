import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MoneyInput } from '../MoneyInput';

const SEP = ' ';

function Harness({
  initial = '',
  onValue,
  accept = () => true,
}: {
  initial?: string;
  onValue?: (value: string) => void;
  /** A parent that may refuse a change (it keeps its old value). */
  accept?: (next: string) => boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <MoneyInput
      label="To‘ldirish summasi"
      value={value}
      onValueChange={(next) => {
        onValue?.(next);
        if (accept(next)) setValue(next);
      }}
      unit="so‘m"
    />
  );
}

const field = () => screen.getByLabelText<HTMLInputElement>('To‘ldirish summasi');

describe('MoneyInput refuses a number that is too long (9 digits)', () => {
  it('typing a digit in the middle of a full number changes nothing and keeps the caret', async () => {
    const onValue = vi.fn();
    render(<Harness initial="123456789" onValue={onValue} />);
    field().focus();
    field().setSelectionRange(3, 3); // "1 2|3 4 5 6 7 8 9" region of the grouped text
    const before = field().selectionStart;
    await userEvent.keyboard('0');
    expect(onValue).not.toHaveBeenCalled();
    expect(field()).toHaveValue(`123${SEP}456${SEP}789`);
    expect(field().selectionStart).toBe(before);
  });

  it('typing at the end of a full number is refused too, the last digit survives', async () => {
    const onValue = vi.fn();
    render(<Harness initial="123456789" onValue={onValue} />);
    await userEvent.type(field(), '5');
    expect(onValue).not.toHaveBeenCalled();
    expect(field()).toHaveValue(`123${SEP}456${SEP}789`);
  });

  it('pasting something that does not fit is refused instead of being cut', async () => {
    const onValue = vi.fn();
    render(<Harness initial="12345" onValue={onValue} />);
    await userEvent.click(field());
    await userEvent.paste('9876543210');
    expect(onValue).not.toHaveBeenCalled();
    expect(field()).toHaveValue(`12${SEP}345`);
  });

  it('a paste that fits exactly is accepted', async () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    await userEvent.click(field());
    await userEvent.paste('987 654 321');
    expect(onValue).toHaveBeenLastCalledWith('987654321');
  });

  it('a long paste whose fraction would make it fit is judged without the fraction', async () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    await userEvent.click(field());
    await userEvent.paste('12 345 678,90 so‘m');
    expect(onValue).toHaveBeenLastCalledWith('12345678');
  });
});

describe('MoneyInput caret when the parent refuses a change', () => {
  it('a pending caret does not go stale: the next edit lands where the user is', async () => {
    // refuse every value above 5 digits, accept the rest
    render(<Harness initial="12345" accept={(next) => next.length <= 5} />);
    field().focus();
    field().setSelectionRange(2, 2);
    await userEvent.keyboard('9'); // refused by the parent: nothing re-renders
    expect(field()).toHaveValue(`12${SEP}345`);
    expect(field().selectionStart).toBe(2);
    // an accepted edit afterwards uses its own caret, not the leftover of the refused one
    await userEvent.keyboard('{Backspace}');
    expect(field()).toHaveValue(`1${SEP}345`);
    expect(field().selectionStart).toBe(1);
  });
});

describe('MoneyInput soft keyboards and composition', () => {
  const beforeInput = (inputType: string) =>
    new InputEvent('beforeinput', { inputType, cancelable: true, bubbles: true });

  it('beforeinput deleteContentBackward after a separator removes the digit before it', () => {
    render(<Harness initial="150000" />);
    field().focus();
    field().setSelectionRange(4, 4); // "150" + separator + "|000"
    const event = beforeInput('deleteContentBackward');
    act(() => {
      field().dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(field()).toHaveValue(`15${SEP}000`);
    expect(field().selectionStart).toBe(2);
  });

  it('beforeinput deleteContentForward before a separator removes the next digit', () => {
    render(<Harness initial="150000" />);
    field().focus();
    field().setSelectionRange(3, 3);
    const event = beforeInput('deleteContentForward');
    act(() => {
      field().dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(field()).toHaveValue(`15${SEP}000`);
  });

  it('beforeinput on a digit is left to the browser', () => {
    render(<Harness initial="150000" />);
    field().focus();
    field().setSelectionRange(2, 2);
    const event = beforeInput('deleteContentBackward');
    act(() => {
      field().dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });

  it('keys pressed during IME composition are not intercepted', () => {
    render(<Harness initial="150000" />);
    field().focus();
    field().setSelectionRange(4, 4);
    const notPrevented = fireEvent.keyDown(field(), { key: 'Backspace', isComposing: true });
    expect(notPrevented).toBe(true);
    expect(field()).toHaveValue(`150${SEP}000`);
  });

  it('beforeinput during composition is left alone as well', () => {
    render(<Harness initial="150000" />);
    field().focus();
    field().setSelectionRange(4, 4);
    const event = new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
      isComposing: true,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      field().dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });
});
