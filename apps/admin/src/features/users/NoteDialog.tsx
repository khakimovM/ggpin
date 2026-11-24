import { StickyNote } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { addUserNote } from '../../lib/api/writes-users';
import { ReasonDialog } from '../common/ReasonDialog';
import { useAdminAction } from '../common/use-admin-action';

interface Props {
  userId: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * A note on a user (every role, docs/04 `users/:id/notes`): one text field, no reason. An unknown
 * outcome is settled by the key void like every other action (every role may void its own key).
 */
export function NoteDialog({ userId, name, open, onOpenChange }: Props) {
  const t = useTranslations();
  const act = useAdminAction();
  return (
    <ReasonDialog
      action={act.idOf('users.note', userId)}
      open={open}
      onOpenChange={onOpenChange}
      title={t('admin.users.dialog.note.title')}
      description={t('admin.users.dialog.note.body', { name })}
      icon={StickyNote}
      submitLabel={t('admin.users.dialog.note.cta')}
      actor={act.actor}
      textField="note"
      onOutcomeFound={(applied) => act.found('users.note', applied)}
      onSubmit={async ({ reason, idempotencyKey }) => {
        const result = await addUserNote(userId, { text: reason }, idempotencyKey);
        act.finished('users.note', result);
      }}
    />
  );
}
