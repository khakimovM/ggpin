import { ADMIN_ROLES } from '@repo/shared';
import { AdminAccountsService } from '../../modules/admin/admins/admin-accounts.service';
import {
  AdminLifecycleService,
  type AdminChangeResult,
} from '../../modules/admin/admins/admin-lifecycle.service';
import {
  ACTOR_OPTIONS,
  ACTOR_USAGE,
  UsageError,
  actorOf,
  flag,
  parse,
  positional,
  report,
  required,
  type CliCommand,
  type CliContext,
} from './command';

// Admin panel accounts (phase 9, D-63 (6)). OWNER is given here and nowhere else; the panel can
// only create OPERATOR and SUPPORT. Access needs two keys: the AdminUser row (this CLI) AND the
// Telegram id in ADMIN_TELEGRAM_IDS (the deployment's env, devops).

const add: CliCommand = {
  name: 'admin:add',
  summary: 'add an admin panel account (OWNER can only be given here)',
  usage:
    `admin:add --telegram-id <id> --name <name> --role ${ADMIN_ROLES.join('|')} ${ACTOR_USAGE}` +
    '   (the reason is 10-500 characters; the account can sign in only once its Telegram id ' +
    'is also in ADMIN_TELEGRAM_IDS)',
  async run(ctx, argv) {
    const p = parse(
      argv,
      {
        ...ACTOR_OPTIONS,
        'telegram-id': { type: 'string' },
        name: { type: 'string' },
        role: { type: 'string' },
      },
      0,
    );
    const { reason, actor } = actorOf(ctx, p);
    const result = await ctx.app.get(AdminAccountsService).addFromCli({
      telegramId: required(p, 'telegram-id'),
      name: required(p, 'name'),
      role: required(p, 'role'),
      reason,
      actor,
    });
    report(ctx, {
      applied: true,
      admin: result.admin.id,
      role: result.admin.role,
      allowlisted: result.allowlisted,
      audit: result.auditId,
    });
    if (!result.allowlisted) {
      ctx.io.err('note: this Telegram id is not in ADMIN_TELEGRAM_IDS: no sign-in until it is.');
    }
  },
};

const list: CliCommand = {
  name: 'admin:list',
  summary: 'list admin panel accounts (role, active, allowlisted, live sessions)',
  usage: 'admin:list',
  async run(ctx, argv) {
    parse(argv, {}, 0);
    const admins = await ctx.app.get(AdminAccountsService).list();
    for (const a of admins) {
      report(ctx, {
        admin:
          `${a.id} role=${a.role} active=${String(a.isActive)} allowlisted=${String(a.allowlisted)}` +
          ` sessions=${String(a.activeSessions)} telegramId=${a.telegramId.toString()} name=${a.name}`,
      });
    }
    report(ctx, { count: admins.length });
  },
};

const LAST_OWNER_USAGE =
  '[--confirm-last-owner: a bare flag, needed only when no other active, allowlisted OWNER would be left]';

/** The result line every account change prints; refuses (exit 2) an unconfirmed last OWNER. */
function changed(ctx: CliContext, result: AdminChangeResult, restore: string): void {
  if (result.outcome === 'needsLastOwnerConfirm') {
    throw new UsageError(
      `admin ${result.adminId} is the last active, allowlisted OWNER: this leaves no OWNER who can sign in. ` +
        'Re-run with --confirm-last-owner only if that is really intended',
    );
  }
  report(ctx, {
    applied: result.outcome === 'applied',
    admin: result.adminId,
    revokedSessions: result.revokedSessions,
    audit: result.auditId,
  });
  if (!result.lastOwnerRemoved) return;
  ctx.io.err(
    'WARNING: no active, allowlisted OWNER is left: owner-only actions are impossible in the panel.',
  );
  ctx.io.err(
    result.usableAdmins === 0
      ? 'WARNING: no active, allowlisted admin is left at all: nobody can sign in to the admin panel.'
      : `WARNING: only ${String(result.usableAdmins)} non-owner admin(s) can still sign in.`,
  );
  ctx.io.err(`restore: ${restore} --reason <text> --operator <name>`);
}

const deactivate: CliCommand = {
  name: 'admin:deactivate',
  summary: 'deactivate an admin account and end all its sessions',
  usage:
    `admin:deactivate <adminId> ${LAST_OWNER_USAGE} ${ACTOR_USAGE}` +
    '   (the reason is 10-500 characters; undo with admin:reactivate)',
  async run(ctx, argv) {
    const p = parse(argv, { ...ACTOR_OPTIONS, 'confirm-last-owner': { type: 'boolean' } }, 1);
    const { reason, actor } = actorOf(ctx, p);
    const adminId = positional(p, 0);
    const result = await ctx.app.get(AdminLifecycleService).deactivate({
      adminId,
      reason,
      actor,
      confirmLastOwner: flag(p, 'confirm-last-owner'),
    });
    changed(ctx, result, `admin:reactivate ${adminId}`);
  },
};

const reactivate: CliCommand = {
  name: 'admin:reactivate',
  summary: 'reactivate an admin account (every old session is ended: it signs in anew)',
  usage: `admin:reactivate <adminId> ${ACTOR_USAGE}   (the reason is 10-500 characters)`,
  async run(ctx, argv) {
    const p = parse(argv, { ...ACTOR_OPTIONS }, 1);
    const { reason, actor } = actorOf(ctx, p);
    const result = await ctx.app
      .get(AdminLifecycleService)
      .reactivate({ adminId: positional(p, 0), reason, actor });
    changed(ctx, result, ''); // a reactivation never removes an OWNER: no restore hint
    if (!result.allowlisted) {
      ctx.io.err('note: this Telegram id is not in ADMIN_TELEGRAM_IDS: no sign-in until it is.');
    }
  },
};

const setRole: CliCommand = {
  name: 'admin:set-role',
  summary: "change an admin's role (OWNER can only be given here; any change ends its sessions)",
  usage:
    `admin:set-role <adminId> --role ${ADMIN_ROLES.join('|')} ${LAST_OWNER_USAGE} ${ACTOR_USAGE}` +
    '   (the reason is 10-500 characters)',
  async run(ctx, argv) {
    const p = parse(
      argv,
      { ...ACTOR_OPTIONS, role: { type: 'string' }, 'confirm-last-owner': { type: 'boolean' } },
      1,
    );
    const { reason, actor } = actorOf(ctx, p);
    const adminId = positional(p, 0);
    const result = await ctx.app.get(AdminLifecycleService).setRole({
      adminId,
      role: required(p, 'role'),
      reason,
      actor,
      confirmLastOwner: flag(p, 'confirm-last-owner'),
    });
    changed(ctx, result, `admin:set-role ${adminId} --role OWNER`);
  },
};

export const ADMIN_COMMANDS: readonly CliCommand[] = [add, list, deactivate, reactivate, setRole];
