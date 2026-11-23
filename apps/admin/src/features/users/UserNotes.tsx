import type { AdminNote } from '@repo/shared';
import { Button, Icon } from '@repo/ui';
import { Plus, StickyNote } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { formatDateTime } from '../../lib/format';
import { ListEmpty } from '../common/ListStates';
import { Panel } from '../common/Panel';
import { useAdminAction } from '../common/use-admin-action';
import { NoteDialog } from './NoteDialog';

interface Props {
  userId: string;
  name: string;
  notes: readonly AdminNote[];
}

/**
 * The newest notes on a user (docs/04: up to 20, older ones are in the audit log) and the way to
 * add one (every role). Text is admin-written content: rendered as text, never as HTML.
 */
export function UserNotes({ userId, name, notes }: Props) {
  const t = useTranslations();
  const act = useAdminAction();
  const [open, setOpen] = useState(false);
  const canAdd = act.can('users.note');
  const add = canAdd ? (
    <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
      <Icon icon={Plus} size={14} />
      {t('admin.users.actions.note')}
    </Button>
  ) : null;
  return (
    <Panel
      title={t('admin.users.notes.title')}
      id="user-notes"
      aside={
        <span className="flex items-center gap-2">
          <span className="text-[11px] leading-4 font-bold text-foreground-muted tabular-nums">
            {t('admin.users.notes.counter', { count: notes.length })}
          </span>
          {notes.length > 0 ? add : null}
        </span>
      }
    >
      {notes.length === 0 ? (
        <ListEmpty icon={StickyNote} title={t('admin.users.notes.empty')} action={add} />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {notes.map((note) => (
            <li key={note.id} className="flex flex-col gap-1 rounded-[10px] bg-surface px-3 py-2.5">
              <p className="m-0 text-[13px] leading-[19px] font-semibold break-words whitespace-pre-wrap">
                {note.text}
              </p>
              <span className="text-[11px] leading-[14px] font-bold text-foreground-muted tabular-nums">
                {t('admin.users.notes.by', {
                  name: note.author.name,
                  time: formatDateTime(note.createdAt),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {open ? (
        <NoteDialog
          userId={userId}
          name={name}
          open
          onOpenChange={(next) => {
            if (!next) setOpen(false);
          }}
        />
      ) : null}
    </Panel>
  );
}
