import { fireEvent, screen } from '@testing-library/react';
import { Undo2 } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { AdminContext } from '../../../app/admin-context';
import { NotSentError, isActionOutcomeUnknown } from '../../../lib/api/errors';
import { meFixture } from '../../../lib/api/mock/fixtures';
import { actionIdempotencyKey, adminActionId, pendingAction } from '../../../lib/idempotency';
import { renderAdmin } from '../../../test/render';
import { ReasonDialog } from '../ReasonDialog';

// SA I-2: a submit that sends nothing must not look like a 2xx: the key stays, nothing is unknown.
const me = meFixture('OWNER', new Date('2026-11-17T09:00:00Z'));

describe('a submit that sent nothing (NotSentError)', () => {
  it('is a definite "not applied", never an unknown outcome', () => {
    expect(isActionOutcomeUnknown(new NotSentError())).toBe(false);
  });

  it('keeps the key and the dialog open, and marks nothing unknown', async () => {
    const action = adminActionId(me.admin.id, 'users.adjustWallet', 'notsent_1');
    const key = actionIdempotencyKey(action);
    const onOpenChange = vi.fn();
    renderAdmin(
      <AdminContext.Provider value={me}>
        <ReasonDialog
          action={action}
          open
          onOpenChange={onOpenChange}
          title="Tuzatish"
          icon={Undo2}
          submitLabel="Tuzatish"
          actor={{ name: me.admin.name, role: me.admin.role }}
          onSubmit={() => Promise.reject(new NotSentError())}
        />
      </AdminContext.Provider>,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Bank xatosi tuzatildi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tuzatish' }));
    await screen.findByRole('alert');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(pendingAction(action)).toMatchObject({ key, unknown: false, conflict: false });
  });
});
