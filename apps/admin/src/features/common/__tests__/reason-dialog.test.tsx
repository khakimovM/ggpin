import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Undo2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, isOutcomeUnknown } from '../../../lib/api/errors';
import {
  actionIdempotencyKey,
  adminActionId,
  pendingAction,
  type AdminActionId,
} from '../../../lib/idempotency';
import { renderAdmin } from '../../../test/render';
import { ConfirmCodeStep } from '../ConfirmCodeStep';
import { ReasonDialog, type ReasonSubmit } from '../ReasonDialog';

type Submit = (input: ReasonSubmit) => Promise<void>;
type User = ReturnType<typeof userEvent.setup>;

const ADMIN_ID = 'cmadminowner01';

let seq = 0;
/** The registry is module-level, so every test gets its own target. */
function nextAction(): AdminActionId {
  seq += 1;
  return adminActionId(ADMIN_ID, 'users.adjustWallet', `dialog_${seq}`);
}

/** A page that opens the dialog with a button, as a real section does. */
function Harness(props: { action: AdminActionId; onSubmit: Submit; children?: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        ochish
      </button>
      <ReasonDialog
        action={props.action}
        open={open}
        onOpenChange={setOpen}
        title="Balansni tuzatish"
        icon={Undo2}
        tone="danger"
        submitLabel="Tuzatish"
        actor={{ name: 'Aziz O.', role: 'OWNER' }}
        onSubmit={props.onSubmit}
      >
        {props.children}
      </ReasonDialog>
    </>
  );
}

const REASON = 'Mijoz so‘rovi bilan';
const UNKNOWN_TEXT = /Natija nomaʼlum/;
const CONFLICT_TEXT = /boshqa maʼlumot bilan bajarilgan/;
const reasonBox = () => screen.getByRole('textbox', { name: /Sabab/ });
const send = (user: User) => user.click(screen.getByRole('button', { name: 'Tuzatish' }));

async function closeAndReopen(user: User) {
  await user.click(screen.getByRole('button', { name: 'Bekor' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: 'ochish' }));
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
}

const keysOf = (onSubmit: ReturnType<typeof vi.fn<Submit>>) =>
  onSubmit.mock.calls.map(([input]) => input.idempotencyKey);
const refusal = (status: number, code: ConstructorParameters<typeof ApiError>[0]['code']) =>
  new ApiError({ status, code, fromServer: true });

const UNKNOWN_OUTCOMES: Array<[string, unknown]> = [
  ['no answer (NETWORK)', new ApiError({ status: 0, code: 'NETWORK' })],
  ['a 5xx in our envelope', refusal(500, 'INTERNAL_ERROR')],
  ['a 502 from a proxy', new ApiError({ status: 502, code: 'INTERNAL_ERROR' })],
  ['a 4xx not in our envelope', new ApiError({ status: 413, code: 'VALIDATION_ERROR' })],
  ['a non-API failure', new TypeError('Failed to fetch')],
];

describe('ReasonDialog', () => {
  it('is an accessible dialog with the audit line', () => {
    renderAdmin(<Harness action={nextAction()} onSubmit={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Balansni tuzatish' })).toBeInTheDocument();
    expect(screen.getByText('Bu amal audit logga yoziladi · Aziz O. (OWNER)')).toBeInTheDocument();
  });

  it('keeps the action disabled until the reason has 10 characters', async () => {
    const user = userEvent.setup();
    renderAdmin(<Harness action={nextAction()} onSubmit={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Tuzatish' })).toBeDisabled();
    await user.type(reasonBox(), 'qisqa');
    await user.tab();
    expect(screen.getByText('Sabab kamida 10 ta belgidan iborat bo‘lsin')).toBeInTheDocument();
    await user.type(reasonBox(), ' sabab matni');
    expect(screen.getByRole('button', { name: 'Tuzatish' })).toBeEnabled();
  });

  it.each(UNKNOWN_OUTCOMES)(
    'after %s: same key, the warning and the reason come back on reopening (SA M-1)',
    async (_name, failure) => {
      const user = userEvent.setup();
      const onSubmit = vi.fn<Submit>().mockRejectedValueOnce(failure).mockResolvedValueOnce();
      renderAdmin(<Harness action={nextAction()} onSubmit={onSubmit} />);
      await user.type(reasonBox(), `  ${REASON}  `);
      await send(user);
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(UNKNOWN_TEXT);
      await closeAndReopen(user);
      expect(screen.getByRole('status')).toHaveTextContent(UNKNOWN_TEXT);
      expect(reasonBox()).toHaveValue(REASON);
      await send(user);
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      const [first, second] = keysOf(onSubmit);
      expect(first).toMatch(/^[0-9a-f-]{36}$/);
      expect(second).toBe(first);
    },
  );

  it('after 409 IDEMPOTENCY_CONFLICT keeps the key and says so', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<Submit>().mockRejectedValue(refusal(409, 'IDEMPOTENCY_CONFLICT'));
    renderAdmin(<Harness action={nextAction()} onSubmit={onSubmit} />);
    await user.type(reasonBox(), REASON);
    await send(user);
    expect(await screen.findByRole('status')).toHaveTextContent(CONFLICT_TEXT);
    await closeAndReopen(user);
    expect(screen.getByRole('status')).toHaveTextContent(CONFLICT_TEXT);
    await send(user);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    const [first, second] = keysOf(onSubmit);
    expect(second).toBe(first);
  });

  it('a wrong code keeps the key, so the right code still matches its binding (CR)', async () => {
    const user = userEvent.setup();
    const action = nextAction();
    const codeKey = actionIdempotencyKey(action);
    const onSubmit = vi
      .fn<Submit>()
      .mockRejectedValueOnce(
        new ApiError({
          status: 422,
          code: 'CODE_INVALID',
          details: { attemptsLeft: 4 },
          fromServer: true,
        }),
      )
      .mockResolvedValueOnce();
    renderAdmin(<Harness action={action} onSubmit={onSubmit} />);
    await user.type(reasonBox(), REASON);
    await send(user);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await send(user);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(keysOf(onSubmit)).toEqual([codeKey, codeKey]);
  });

  it.each([
    ['404', refusal(404, 'NOT_FOUND')],
    ['429', refusal(429, 'RATE_LIMITED')],
    ['400', refusal(400, 'VALIDATION_ERROR')],
  ])(
    'unknown, then %s, then reopening: same key and the warning stays (SA M-1R)',
    async (_s, then) => {
      const user = userEvent.setup();
      const onSubmit = vi
        .fn<Submit>()
        .mockRejectedValueOnce(new ApiError({ status: 0, code: 'NETWORK' }))
        .mockRejectedValueOnce(then)
        .mockResolvedValueOnce();
      renderAdmin(<Harness action={nextAction()} onSubmit={onSubmit} />);
      await user.type(reasonBox(), REASON);
      await send(user);
      expect(await screen.findByRole('status')).toHaveTextContent(UNKNOWN_TEXT);
      await send(user);
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
      expect(await screen.findByRole('status')).toHaveTextContent(UNKNOWN_TEXT);
      await closeAndReopen(user);
      expect(screen.getByRole('status')).toHaveTextContent(UNKNOWN_TEXT);
      await send(user);
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(3));
      expect(new Set(keysOf(onSubmit)).size).toBe(1);
    },
  );

  it('gives the next opening a new key after a success', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<Submit>().mockResolvedValue();
    renderAdmin(<Harness action={nextAction()} onSubmit={onSubmit} />);
    await user.type(reasonBox(), REASON);
    await send(user);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'ochish' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(reasonBox()).toHaveValue('');
    await user.type(reasonBox(), REASON);
    await send(user);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    const [first, second] = keysOf(onSubmit);
    expect(second).not.toBe(first);
  });

  it('refills the reason but never the code after an unknown outcome', async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn<Submit>()
      .mockRejectedValue(new ApiError({ status: 0, code: 'NETWORK' }));
    const requestCode = vi
      .fn()
      .mockResolvedValue({ challengeId: 'c'.repeat(32), expiresInSec: 180 });
    renderAdmin(
      <Harness action={nextAction()} onSubmit={onSubmit}>
        <ConfirmCodeStep requestCode={requestCode} onChange={vi.fn()} />
      </Harness>,
    );
    await user.type(reasonBox(), REASON);
    await user.click(screen.getByRole('button', { name: 'Kodni olish' }));
    expect(await screen.findByText(/amal qiladi/)).toBeInTheDocument();
    await user.keyboard('123456');
    await send(user);
    expect(await screen.findByRole('status')).toHaveTextContent(UNKNOWN_TEXT);
    await closeAndReopen(user);
    expect(reasonBox()).toHaveValue(REASON);
    expect(screen.getByRole('button', { name: 'Kodni olish' })).toBeInTheDocument();
    expect(screen.queryByText(/amal qiladi/)).not.toBeInTheDocument();
  });

  it('records an unknown outcome that arrives after the dialog unmounted', async () => {
    const user = userEvent.setup();
    const action = nextAction();
    let fail: (error: unknown) => void = () => undefined;
    const onSubmit = vi.fn<Submit>(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const view = renderAdmin(<Harness action={action} onSubmit={onSubmit} />);
    await user.type(reasonBox(), REASON);
    await send(user);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    view.unmount();
    fail(new ApiError({ status: 0, code: 'NETWORK' }));
    await waitFor(() => expect(pendingAction(action)?.unknown).toBe(true));
    expect(pendingAction(action)).toMatchObject({ key: keysOf(onSubmit)[0], reason: REASON });
  });
});

describe('isOutcomeUnknown', () => {
  it.each(UNKNOWN_OUTCOMES)('is true for %s', (_name, failure) => {
    expect(isOutcomeUnknown(failure)).toBe(true);
  });

  it('is true for 409 IDEMPOTENCY_CONFLICT and false for other refusals in our envelope', () => {
    expect(isOutcomeUnknown(refusal(409, 'IDEMPOTENCY_CONFLICT'))).toBe(true);
    for (const [status, code] of [
      [404, 'NOT_FOUND'],
      [409, 'ORDER_STATE_CONFLICT'],
      [422, 'CODE_INVALID'],
      [429, 'RATE_LIMITED'],
    ] as const) {
      expect(isOutcomeUnknown(refusal(status, code))).toBe(false);
    }
  });
});
