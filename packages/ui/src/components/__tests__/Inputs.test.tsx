import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Input, type InputKind } from '../Input';
import { MoneyInput, parseSom } from '../MoneyInput';
import { Stepper } from '../Stepper';
import { Switch } from '../Switch';

function InputHarness({ kind, error }: { kind?: InputKind; error?: string }) {
  const [value, setValue] = useState('');
  return (
    <Input
      label="Telegram username"
      value={value}
      onValueChange={setValue}
      kind={kind}
      error={error}
      help="Stars shu akkauntga yuboriladi"
    />
  );
}

describe('Input', () => {
  it('links the label, and shows help text through aria-describedby', () => {
    render(<InputHarness />);
    const field = screen.getByLabelText('Telegram username');
    expect(field).toHaveAccessibleDescription('Stars shu akkauntga yuboriladi');
    expect(field).not.toHaveAttribute('aria-invalid');
  });

  it('shows the error instead of the help text and flags the field invalid', () => {
    render(<InputHarness error="Akkaunt topilmadi" />);
    const field = screen.getByLabelText('Telegram username');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('Akkaunt topilmadi');
    expect(screen.getByRole('alert')).toHaveTextContent('Akkaunt topilmadi');
    expect(screen.queryByText('Stars shu akkauntga yuboriladi')).not.toBeInTheDocument();
  });

  it('username kind drops a typed or pasted "@" and invalid characters', async () => {
    render(<InputHarness kind="username" />);
    const field = screen.getByLabelText('Telegram username');
    await userEvent.click(field);
    await userEvent.paste('@dilnoza-k!');
    expect(field).toHaveValue('dilnozak');
  });

  it('digits kind keeps digits only and asks for a numeric keypad', async () => {
    render(<InputHarness kind="digits" />);
    const field = screen.getByLabelText('Telegram username');
    expect(field).toHaveAttribute('inputmode', 'numeric');
    await userEvent.type(field, '51a2-3');
    expect(field).toHaveValue('5123');
  });
});

function MoneyHarness({
  initial = '',
  onValue,
}: {
  initial?: string;
  onValue?: (v: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <MoneyInput
      label="To‘ldirish summasi"
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
      unit="so‘m"
      min="1000"
      max="5000000"
      minError="Minimal 1 000 so‘m"
      maxError="Maksimal 5 000 000 so‘m"
      quickAmounts={[
        { value: '50000', label: '+50 000' },
        { value: '100000', label: '+100 000' },
      ]}
    />
  );
}

describe('MoneyInput', () => {
  it('accepts digits only and reports whole so‘m digits to the parent', async () => {
    const onValue = vi.fn();
    render(<MoneyHarness onValue={onValue} />);
    const field = screen.getByLabelText('To‘ldirish summasi');
    await userEvent.type(field, '12ab50');
    expect(onValue).toHaveBeenLastCalledWith('1250');
  });

  it('groups thousands with the same narrow space formatMoney uses', () => {
    render(<MoneyHarness initial="1250000" />);
    expect(screen.getByLabelText('To‘ldirish summasi')).toHaveValue('1 250 000');
  });

  it('drops leading zeros and limits the length', async () => {
    const onValue = vi.fn();
    render(<MoneyHarness onValue={onValue} />);
    await userEvent.type(screen.getByLabelText('To‘ldirish summasi'), '00012345678901');
    expect(onValue).toHaveBeenLastCalledWith('123456789');
  });

  it('shows the minimum error only once there is a value below it', async () => {
    render(<MoneyHarness />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('To‘ldirish summasi'), '500');
    expect(screen.getByRole('alert')).toHaveTextContent('Minimal 1 000 so‘m');
    expect(screen.getByLabelText('To‘ldirish summasi')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows the maximum error above the limit', () => {
    render(<MoneyHarness initial="6000000" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Maksimal 5 000 000 so‘m');
  });

  it('quick amount chips add to the current amount', async () => {
    const onValue = vi.fn();
    render(<MoneyHarness initial="20000" onValue={onValue} />);
    await userEvent.click(screen.getByRole('button', { name: '+50 000' }));
    expect(onValue).toHaveBeenLastCalledWith('70000');
  });
});

describe('MoneyInput parsing', () => {
  it.each([
    // fractions are dropped, whatever separator style and unit text come with them
    ['37 050,50', '37050'],
    ['37 050,50 so‘m', '37050'],
    ['37 050,50 сум', '37050'],
    ['50,00 UZS', '50'],
    ['1.000,50', '1000'],
    ['10,000.50', '10000'],
    ['1,234,567.89', '1234567'],
    ['1.000,5', '1000'],
    ['1 000.5 so‘m', '1000'],
    ['150000.00', '150000'],
    ['12.5', '12'],
    ['1,5', '1'],
    ['1.50', '1'],
    // separators followed by three digits are thousands separators
    ['1 000 000', '1000000'],
    ['1.000.000', '1000000'],
    ['1,000', '1000'],
    ['1.000', '1000'],
    ['1,000,000 so‘m', '1000000'],
    // the rest
    ['150 000,', '150000'],
    ['007', '7'],
    ['abc', ''],
    ['', ''],
  ])('reads %j as %j whole so‘m (a fraction is never glued on)', (raw, expected) => {
    expect(parseSom(raw)).toBe(expected);
  });

  it('does not cut a long number: the caller decides what too long means', () => {
    expect(parseSom('1234567890123')).toBe('1234567890123');
  });

  it('pasting "37 050,50" gives 37 050, not 3 705 050', async () => {
    const onValue = vi.fn();
    render(<MoneyHarness onValue={onValue} />);
    await userEvent.click(screen.getByLabelText('To‘ldirish summasi'));
    await userEvent.paste('37 050,50');
    expect(onValue).toHaveBeenLastCalledWith('37050');
  });

  it('quick amounts cap at the digit limit instead of cutting the last digits', async () => {
    const onValue = vi.fn();
    render(<MoneyHarness initial="999950000" onValue={onValue} />);
    await userEvent.click(screen.getByRole('button', { name: '+100 000' }));
    expect(onValue).toHaveBeenLastCalledWith('999999999');
  });
});

describe('MoneyInput caret', () => {
  const SEP = ' ';

  it('typing in the middle keeps the caret next to the new digit after regrouping', async () => {
    render(<MoneyHarness initial="150000" />);
    const field = screen.getByLabelText<HTMLInputElement>('To‘ldirish summasi');
    field.focus();
    field.setSelectionRange(3, 3); // "150|" + separator + "000"
    await userEvent.keyboard('9');
    expect(field).toHaveValue(`1${SEP}509${SEP}000`);
    expect(field.selectionStart).toBe(5); // right after the typed 9
    expect(field.selectionEnd).toBe(5);
  });

  it('Backspace right after a separator removes the digit before it', async () => {
    render(<MoneyHarness initial="150000" />);
    const field = screen.getByLabelText<HTMLInputElement>('To‘ldirish summasi');
    field.focus();
    field.setSelectionRange(4, 4); // "150" + separator + "|000"
    await userEvent.keyboard('{Backspace}');
    expect(field).toHaveValue(`15${SEP}000`);
    expect(field.selectionStart).toBe(2);
  });

  it('Delete right before a separator removes the digit after it', async () => {
    render(<MoneyHarness initial="150000" />);
    const field = screen.getByLabelText<HTMLInputElement>('To‘ldirish summasi');
    field.focus();
    field.setSelectionRange(3, 3); // "150|" + separator + "000"
    await userEvent.keyboard('{Delete}');
    expect(field).toHaveValue(`15${SEP}000`);
    expect(field.selectionStart).toBe(4);
  });

  it('Backspace on a digit still works as usual and keeps the caret in place', async () => {
    render(<MoneyHarness initial="1250000" />);
    const field = screen.getByLabelText<HTMLInputElement>('To‘ldirish summasi');
    field.focus();
    field.setSelectionRange(3, 3); // "1" sep "2|50" sep "000"
    await userEvent.keyboard('{Backspace}');
    expect(field).toHaveValue(`150${SEP}000`);
    expect(field.selectionStart).toBe(1);
  });
});

function StepperHarness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <Stepper
      label="Stars miqdori"
      value={value}
      onValueChange={setValue}
      min={50}
      max={1000}
      step={50}
      decrementLabel="Kamaytirish"
      incrementLabel="Ko‘paytirish"
    />
  );
}

describe('Stepper', () => {
  it('steps within min and max and disables the buttons at the limits', async () => {
    render(<StepperHarness initial="50" />);
    expect(screen.getByRole('button', { name: 'Kamaytirish' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Ko‘paytirish' }));
    expect(screen.getByLabelText('Stars miqdori')).toHaveValue('100');
    expect(screen.getByRole('button', { name: 'Kamaytirish' })).toBeEnabled();
  });

  it('disables increment at the maximum', () => {
    render(<StepperHarness initial="1000" />);
    expect(screen.getByRole('button', { name: 'Ko‘paytirish' })).toBeDisabled();
  });

  it('keeps typed digits only so the parent can validate the range', async () => {
    render(<StepperHarness initial="" />);
    await userEvent.type(screen.getByLabelText('Stars miqdori'), '7x');
    expect(screen.getByLabelText('Stars miqdori')).toHaveValue('7');
  });
});

describe('Switch', () => {
  it('toggles with a click and with the keyboard, and exposes its state', async () => {
    const onCheckedChange = vi.fn();
    function Harness() {
      const [checked, setChecked] = useState(false);
      return (
        <Switch
          checked={checked}
          onCheckedChange={(next) => {
            setChecked(next);
            onCheckedChange(next);
          }}
          label="Animatsiyalarni kamaytirish"
        />
      );
    }
    render(<Harness />);
    const toggle = screen.getByRole('switch', { name: 'Animatsiyalarni kamaytirish' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await userEvent.keyboard(' ');
    expect(onCheckedChange).toHaveBeenNthCalledWith(1, true);
    expect(onCheckedChange).toHaveBeenNthCalledWith(2, false);
  });
});
