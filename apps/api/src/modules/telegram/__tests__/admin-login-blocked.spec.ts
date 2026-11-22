import type { AdminIssueCodeResult } from '../../admin/auth/admin-login.service';
import {
  adminDenyCallbackData,
  adminSessionEndCallbackData,
} from '../../admin/auth/admin-callbacks';
import { createHarness, makeUser } from './bot-harness';
import { callbackUpdate, textUpdate } from './updates';

// SA-S6-1: an admin whose STORE account is blocked must still log in to the panel and end its
// sessions from the bot; every other update of a blocked account still gets the blocked reply.
const ID = 700_902;
const NONCE = 'b'.repeat(43);
const CODE = '615244';
const issued: AdminIssueCodeResult = { ok: true, code: CODE, origin: null };
const blocked = () => [makeUser(BigInt(ID), { locale: 'uz', isBlocked: true })];
const BLOCKED_TEXT = 'Hisobingiz bloklangan. Yordam xizmatiga murojaat qiling.';

describe('a blocked store account of an admin (SA-S6-1)', () => {
  it('still gets the /start admin_ code (the admin service decides who may)', async () => {
    const h = createHarness({
      users: blocked(),
      adminLogin: { issueCode: () => Promise.resolve(issued) },
    });
    await h.send(textUpdate({ id: ID }, `/start admin_${NONCE}`));
    expect(h.adminCalls.map((c) => c.method)).toEqual(['issueCode']);
    const text = String(h.callsOf('sendMessage')[0]?.payload['text']);
    expect(text).toContain(`<code>${CODE}</code>`);
    expect(text).not.toContain(BLOCKED_TEXT);
  });

  it('a blocked non-admin gets the dead-link answer from the service, never a code', async () => {
    const h = createHarness({ users: blocked() });
    await h.send(textUpdate({ id: ID }, `/start admin_${NONCE}`));
    expect(h.adminCalls.map((c) => c.method)).toEqual(['issueCode']);
    expect(String(h.callsOf('sendMessage')[0]?.payload['text'])).not.toMatch(/<code>/);
  });

  it('still reaches the ad: and ae: "this was not me" buttons', async () => {
    const h = createHarness({
      users: blocked(),
      adminLogin: { deny: () => Promise.resolve('denied') },
      adminSessions: { endFromBot: () => Promise.resolve('ended') },
    });
    await h.send(callbackUpdate({ id: ID }, adminDenyCallbackData(NONCE)));
    await h.send(
      callbackUpdate({ id: ID }, adminSessionEndCallbackData('cmadminsession0000000002')),
    );
    expect(h.adminCalls.map((c) => c.method)).toEqual(['deny', 'endFromBot']);
  });

  it('every other update of the blocked account gets only the blocked reply', async () => {
    const h = createHarness({
      users: blocked(),
      adminLogin: { issueCode: () => Promise.resolve(issued) },
    });
    await h.send(textUpdate({ id: ID }, '/start'));
    await h.send(textUpdate({ id: ID }, `/start login_${NONCE}`));
    await h.send(textUpdate({ id: ID }, `admin_${NONCE}`));
    expect(h.adminCalls).toEqual([]);
    const texts = h.callsOf('sendMessage').map((c) => String(c.payload['text']));
    expect(texts).toEqual([BLOCKED_TEXT, BLOCKED_TEXT, BLOCKED_TEXT]);
  });
});
