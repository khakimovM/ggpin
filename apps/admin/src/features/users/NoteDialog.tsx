import { StickyNote } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { getUser } from '../../lib/api/people';
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
 * A note on a user (every role, docs/04 `users/:id/notes`): one text field, no reason. The
 * note's id is its audit row's id, so a SUPPORT admin, who cannot read the audit log, checks an
 * unknown outcome in the user's newest notes instead (plan 5.1, Q1).
 */
export function NoteDialog({ userId, name, open, onOpenChange }: Props) {
  const t = useTranslations();
  const act = useAdminAction();
  const lookupOutcome = act.can('audit.read')
    ? undefined
    : async (auditId: string) => (await getUser(userId)).notes.some((note) => note.id === auditId);
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
      {...(lookupOutcome === undefined ? {} : { lookupOutcome })}
      onOutcomeFound={() => act.found('users.note')}
      onSubmit={async ({ reason, idempotencyKey }) => {
        const result = await addUserNote(userId, { text: reason }, idempotencyKey);
        act.finished('users.note', result);
      }}
    />
  );
}
