// Opposite actions on one target (SA L-2, owner variant (a)). The panel gives up on a write after
// 30 s while the API may still run it until its 45 s deadline: in that window an unknown "block"
// could commit AFTER an "unblock" sent meanwhile and silently undo it. So while one side of a pair
// has an unknown outcome, the other side is locked too, until the key void settles the first.
import {
  actionParts,
  adminActionId,
  pendingAction,
  pendingInFlight,
  type AdminActionId,
  type AdminActionKind,
} from './idempotency';

export type OppositeTitleKey =
  | 'admin.payments.cards.dialog.pause.title'
  | 'admin.payments.cards.dialog.resume.title'
  | 'admin.users.dialog.block.title'
  | 'admin.users.dialog.unblock.title'
  | 'admin.users.dialog.freeze.title'
  | 'admin.users.dialog.unfreeze.title'
  | 'admin.admins.dialog.deactivate.title'
  | 'admin.admins.dialog.reactivate.title';

/** One side of a pair: the registry kind, the registry target suffix, the dialog title it has. */
export interface OppositeSide {
  kind: AdminActionKind;
  /** Appended to the record id in the registry target (`AdminChangeDialog` modes), else ''. */
  suffix: string;
  /** The title of that side's dialog, which names the action to the operator. */
  titleKey: OppositeTitleKey;
}

/** Every pair of opposite actions: the single source the lock and its test read. */
export const OPPOSITE_ACTIONS: ReadonlyArray<readonly [OppositeSide, OppositeSide]> = [
  [
    { kind: 'cards.pause', suffix: '', titleKey: 'admin.payments.cards.dialog.pause.title' },
    { kind: 'cards.resume', suffix: '', titleKey: 'admin.payments.cards.dialog.resume.title' },
  ],
  [
    { kind: 'users.block', suffix: '', titleKey: 'admin.users.dialog.block.title' },
    { kind: 'users.unblock', suffix: '', titleKey: 'admin.users.dialog.unblock.title' },
  ],
  [
    { kind: 'users.freeze', suffix: '', titleKey: 'admin.users.dialog.freeze.title' },
    { kind: 'users.unfreeze', suffix: '', titleKey: 'admin.users.dialog.unfreeze.title' },
  ],
  [
    {
      kind: 'admins.update',
      suffix: '-deactivate',
      titleKey: 'admin.admins.dialog.deactivate.title',
    },
    {
      kind: 'admins.update',
      suffix: '-reactivate',
      titleKey: 'admin.admins.dialog.reactivate.title',
    },
  ],
];

function matches(side: OppositeSide, kind: AdminActionKind, targetId: string): boolean {
  if (side.kind !== kind) return false;
  // `admins.update` without a suffix is the plain change, which has no opposite.
  return side.suffix === '' || (targetId.endsWith(side.suffix) && targetId !== side.suffix);
}

/** The registry id of `action`'s opposite on the same target, with its side; null if none. */
export function oppositeOf(
  action: AdminActionId,
): { action: AdminActionId; side: OppositeSide } | null {
  const { adminId, kind, targetId } = actionParts(action);
  for (const pair of OPPOSITE_ACTIONS) {
    for (const [index, side] of pair.entries()) {
      if (!matches(side, kind, targetId)) continue;
      const other = pair[index === 0 ? 1 : 0];
      const record = targetId.slice(0, targetId.length - side.suffix.length);
      return {
        action: adminActionId(adminId, other.kind, `${record}${other.suffix}`),
        side: other,
      };
    }
  }
  return null;
}

/** Why `action` must wait: its opposite's outcome is unknown (its void settles it) or an
 * attempt of it is still out in this tab (only its answer settles it; no void is sent then). */
export interface BlockingOpposite {
  action: AdminActionId;
  side: OppositeSide;
  waiting: 'outcome' | 'answer';
}

/** The opposite action that locks `action` now (SA L-2, L-4), or null. */
export function blockingOpposite(action: AdminActionId): BlockingOpposite | null {
  const opposite = oppositeOf(action);
  if (opposite === null) return null;
  if (pendingAction(opposite.action)?.unknown === true) return { ...opposite, waiting: 'outcome' };
  // SA L-4: the opposite was sent and its dialog closed; it may still commit after this one.
  if (pendingInFlight(opposite.action)) return { ...opposite, waiting: 'answer' };
  return null;
}
