// User writes of the dev mock (docs/04 «Foydalanuvchilar»): block / unblock / freeze / unfreeze,
// end sessions, notes, the wallet adjustment and its preview. Money is BigInt tiyin here too.
import {
  AdminAdjustPreviewQuerySchema,
  AdminAdjustPreviewResponseSchema,
  AdminAdjustWalletBodySchema,
  AdminAdjustWalletResponseSchema,
  AdminNoteBodySchema,
  AdminNoteResponseSchema,
  AdminReasonBodySchema,
  AdminUserSessionsRevokeResponseSchema,
  AdminUserStateResponseSchema,
} from '@repo/shared';
import { ago, mid } from './data-common';
import { USERS } from './fixtures-users';
import type { Journal } from './mock-journal';
import { journalNote, readJournal } from './mock-journal';
import { MOCK_THRESHOLD_TIYIN } from './mock-step-up';
import { userView } from './mock-views';
import { fail, ok, type MockRoute } from './router';
import { checkCode, fieldError, writeRoute } from './write-kit';

/** The user with recent automatic top-ups and open orders in the preview (sardor_r). */
const BUSY_USER = mid('user', 1);
const RECENT_SET = 'a1b2c3d4e5f6';
const OPEN_ORDERS_SET = 'f6e5d4c3b2a1';
const DAILY_CAP_TIYIN = '500000000';

const userOf = (id: string | undefined) => USERS.find((user) => user.id === id);

function stateRoute(
  path: 'block' | 'unblock' | 'freeze' | 'unfreeze',
  permission: 'users.block' | 'users.unblock' | 'users.freeze' | 'users.unfreeze',
  action: string,
): MockRoute {
  const field = path === 'block' || path === 'unblock' ? 'isBlocked' : 'purchaseFrozen';
  const wanted = path === 'block' || path === 'freeze';
  return writeRoute({
    pattern: `/admin/users/:id/${path}`,
    permission,
    body: AdminReasonBodySchema,
    response: AdminUserStateResponseSchema,
    run: ({ params, body, journal, audit, auditId }) => {
      const user = userOf(params.id);
      if (user === undefined) return fail('NOT_FOUND');
      const now = { ...userView(user), ...journal.users[user.id] };
      if (now[field] === wanted) {
        return ok({
          userId: user.id,
          isBlocked: now.isBlocked,
          purchaseFrozen: now.purchaseFrozen,
          revokedSessions: 0,
          auditId: null,
          applied: false,
        });
      }
      const ends = path === 'block' && journal.users[user.id]?.sessionsEnded !== true;
      journal.users[user.id] = {
        ...journal.users[user.id],
        [field]: wanted,
        ...(ends ? { sessionsEnded: true } : {}),
      };
      audit({ action, targetType: 'User', targetId: user.id, reason: body.reason });
      const after = { ...now, [field]: wanted };
      return ok({
        userId: user.id,
        isBlocked: after.isBlocked,
        purchaseFrozen: after.purchaseFrozen,
        revokedSessions: ends ? 2 : 0,
        auditId,
        applied: true,
      });
    },
  });
}

function preview(userId: string, amount: bigint, journal?: Journal) {
  const user = userOf(userId);
  if (user === undefined) return undefined;
  // The draft journal inside a write, the stored one for the preview read.
  const delta = (journal ?? readJournal()).users[userId]?.balanceDeltaTiyin ?? '0';
  const balance = BigInt(user.balanceTiyin) + BigInt(delta);
  const credit = amount > 0n;
  const busy = credit && userId === BUSY_USER;
  return AdminAdjustPreviewResponseSchema.parse({
    balanceTiyin: balance.toString(),
    newBalanceTiyin: (balance + amount).toString(),
    otpRequired: credit || -amount > MOCK_THRESHOLD_TIYIN,
    otpReason: credit ? 'CREDIT' : -amount > MOCK_THRESHOLD_TIYIN ? 'ABOVE_THRESHOLD' : null,
    recentAutoTopups: busy
      ? [{ paymentId: mid('pay', 1), amountTiyin: '10000000', confirmedAt: ago(30) }]
      : [],
    confirmOverrideSet: busy ? RECENT_SET : null,
    openOrders: busy
      ? [
          {
            id: mid('ord', 3),
            number: 10423,
            status: 'PROCESSING',
            priceTiyin: '12075000',
            createdAt: ago(12),
          },
        ]
      : [],
    confirmOpenOrdersSet: busy ? OPEN_ORDERS_SET : null,
    manualCreditToday: { usedTiyin: '0', capTiyin: DAILY_CAP_TIYIN },
  });
}

const adjustRoute = writeRoute({
  pattern: '/admin/users/:id/adjust-wallet',
  permission: 'users.adjustWallet',
  body: AdminAdjustWalletBodySchema,
  response: AdminAdjustWalletResponseSchema,
  run: (context) => {
    const { params, body, journal, audit, auditId, key } = context;
    const amount = BigInt(body.amountTiyin);
    const view = preview(params.id ?? '', amount, journal);
    if (view === undefined) return fail('NOT_FOUND');
    if (view.confirmOverrideSet !== null && body.confirmOverrideSet !== view.confirmOverrideSet) {
      return fieldError('user', 'RECENT_AUTO_TOPUP');
    }
    if (
      view.confirmOpenOrdersSet !== null &&
      body.confirmOpenOrdersSet !== view.confirmOpenOrdersSet
    ) {
      return fieldError('user', 'OPEN_ORDERS');
    }
    const refused = checkCode(context, {
      required: view.otpRequired,
      confirmation: {
        action: 'users.adjustWallet',
        targetId: params.id ?? '',
        amountTiyin: body.confirmAmountTiyin ?? body.amountTiyin,
        ...(body.confirmOverrideSet === undefined
          ? {}
          : { confirmOverrideSet: body.confirmOverrideSet }),
        ...(body.confirmOpenOrdersSet === undefined
          ? {}
          : { confirmOpenOrdersSet: body.confirmOpenOrdersSet }),
        idempotencyKey: key,
      },
      amountTiyin: body.amountTiyin,
    });
    if (refused !== null) return refused;
    const userId = params.id ?? '';
    const before = BigInt(journal.users[userId]?.balanceDeltaTiyin ?? '0');
    journal.users[userId] = {
      ...journal.users[userId],
      balanceDeltaTiyin: (before + amount).toString(),
    };
    audit({ action: 'WALLET_ADJUST', targetType: 'User', targetId: userId, reason: body.reason });
    return ok({
      ledgerEntryId: mid('led', 900),
      balanceTiyin: view.newBalanceTiyin,
      frozen: false,
      auditId,
      applied: true,
    });
  },
});

export const userWriteRoutes: readonly MockRoute[] = [
  stateRoute('block', 'users.block', 'USER_BLOCK'),
  stateRoute('unblock', 'users.unblock', 'USER_UNBLOCK'),
  stateRoute('freeze', 'users.freeze', 'USER_FREEZE'),
  stateRoute('unfreeze', 'users.unfreeze', 'USER_UNFREEZE'),
  writeRoute({
    pattern: '/admin/users/:id/sessions/revoke',
    permission: 'users.sessionsRevoke',
    body: AdminReasonBodySchema,
    response: AdminUserSessionsRevokeResponseSchema,
    run: ({ params, body, journal, audit, auditId }) => {
      const user = userOf(params.id);
      if (user === undefined) return fail('NOT_FOUND');
      const revoked = journal.users[user.id]?.sessionsEnded ? 0 : 2;
      journal.users[user.id] = { ...journal.users[user.id], sessionsEnded: true };
      audit({
        action: 'USER_SESSIONS_REVOKE',
        targetType: 'User',
        targetId: user.id,
        reason: body.reason,
      });
      return ok({ userId: user.id, revokedSessions: revoked, auditId, applied: true });
    },
  }),
  writeRoute({
    pattern: '/admin/users/:id/notes',
    permission: 'users.note',
    body: AdminNoteBodySchema,
    response: AdminNoteResponseSchema,
    run: ({ params, body, journal, audit, auditId, admin, now }) => {
      const user = userOf(params.id);
      if (user === undefined) return fail('NOT_FOUND');
      const note = { id: auditId, text: body.text, createdAt: now.toISOString(), author: admin };
      journalNote(user.id, note, journal);
      audit({ action: 'USER_NOTE', targetType: 'User', targetId: user.id, reason: null });
      return ok({ note, auditId, applied: true });
    },
  }),
  adjustRoute,
  {
    method: 'GET',
    pattern: '/admin/users/:id/adjust-preview',
    permission: 'users.adjustPreview',
    handler: ({ params, query }) => {
      const parsed = AdminAdjustPreviewQuerySchema.safeParse(Object.fromEntries(query));
      if (!parsed.success) return fieldError('amountTiyin');
      const view = preview(params.id ?? '', BigInt(parsed.data.amountTiyin));
      return view === undefined ? fail('NOT_FOUND') : ok(view);
    },
  },
];
