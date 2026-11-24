import type { AdminAccount, AdminPermission } from '@repo/shared';
import { FOCUS_RING, Icon, cn } from '@repo/ui';
import { Lock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useAdminAction } from '../common/use-admin-action';
import { AdminChangeDialog, type AdminChangeMode } from './AdminChangeDialog';
import { RevokeSessionsDialog } from './RevokeSessionsDialog';

type Open = AdminChangeMode | 'revokeAll';

interface Button {
  id: Open;
  /** The write the button's dialog sends (S8b lesson: each button by its own permission). */
  permission: AdminPermission;
  danger: boolean;
}

/** The design's row button (AdminOps.dc.html admins: 28px, 7px radius, 11px extrabold). */
const ROW_BUTTON =
  'relative inline-flex h-7 items-center rounded-[7px] border-[1.5px] bg-transparent px-2.5 text-[11px] leading-none font-extrabold whitespace-nowrap';

/** Which buttons a row has: an OWNER row only "end sessions" (Q7 a and b). */
export function rowButtons(admin: AdminAccount): Button[] {
  const owner = admin.role === 'OWNER';
  const buttons: Button[] = [];
  if (!owner) buttons.push({ id: 'change', permission: 'admins.update', danger: false });
  if (admin.activeSessions > 0) {
    buttons.push({ id: 'revokeAll', permission: 'admins.sessionsRevoke', danger: false });
  }
  if (!owner) {
    buttons.push(
      admin.isActive
        ? { id: 'deactivate', permission: 'admins.update', danger: true }
        : { id: 'reactivate', permission: 'admins.update', danger: false },
    );
  }
  return buttons;
}

/**
 * The actions cell of an admin row. An OWNER row is read-only in the panel (Q7 a, `OWNER_ROW`):
 * it says so, and keeps only ending its sessions (Q7 b, with the code; the server alerts).
 */
export function AdminRowActions({ admin }: { admin: AdminAccount }) {
  const t = useTranslations();
  const act = useAdminAction();
  const [open, setOpen] = useState<Open | null>(null);
  const visible = rowButtons(admin).filter((button) => act.can(button.permission));
  const cell = useRef<HTMLSpanElement>(null);
  // Set when a dialog of this row closes, cleared once focus moves on to another element.
  const returning = useRef(false);
  const close = (next: boolean) => {
    if (next) return;
    returning.current = true;
    setOpen(null);
  };
  const signature = visible.map((button) => button.id).join();
  // CR-S9b-4: the reload after an action may remove the button focus went back to (deactivate ⇄
  // reactivate, end sessions at 0); focus then falls to <body>. Bring it back to this row.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const box = cell.current;
      if (!returning.current || box === null || open !== null) return;
      const lost = document.activeElement === null || document.activeElement === document.body;
      if (!lost) return;
      (box.querySelector<HTMLButtonElement>('button') ?? box).focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [signature, open]);
  return (
    <span
      ref={cell}
      tabIndex={-1}
      role="group"
      aria-label={t('admin.list.actions')}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && !event.currentTarget.contains(next)) returning.current = false;
      }}
      className="flex items-center justify-end gap-1.5 outline-none"
    >
      {admin.role === 'OWNER' ? (
        <span className="flex items-center gap-1 text-[11px] leading-[14px] font-bold whitespace-nowrap text-foreground-muted">
          <Icon icon={Lock} size={12} />
          {t('admin.admins.ownerCliOnly')}
        </span>
      ) : null}
      {visible.map((button) => (
        <button
          // One node for deactivate ⇄ reactivate, so focus stays on it when the state flips.
          key={button.id === 'reactivate' ? 'deactivate' : button.id}
          type="button"
          // The visible word first, then whose row (label in name, WCAG 2.5.3).
          aria-label={t('admin.admins.actions.named', {
            action: t(`admin.admins.actions.${button.id}`),
            name: admin.name,
          })}
          onClick={() => setOpen(button.id)}
          className={cn(
            ROW_BUTTON,
            FOCUS_RING,
            button.danger
              ? 'border-danger text-danger-text hover:bg-danger-soft'
              : 'border-border text-foreground hover:bg-muted',
          )}
        >
          {t(`admin.admins.actions.${button.id}`)}
        </button>
      ))}
      {open === 'revokeAll' ? (
        <RevokeSessionsDialog target={{ kind: 'admin', admin }} onOpenChange={close} />
      ) : null}
      {open !== null && open !== 'revokeAll' ? (
        <AdminChangeDialog admin={admin} mode={open} onOpenChange={close} />
      ) : null}
    </span>
  );
}
