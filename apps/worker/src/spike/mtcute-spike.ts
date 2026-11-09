// Phase 4 S0 spike entry point (branch spike/p4-mtcute, never merged to main).
// Proves @mtcute/node@0.32.7 on the Telegram TEST DC from a CJS `nest build` output.
// Run: MTCUTE_TEST_CREDENTIALS=<path> node dist/spike/mtcute-spike.js
import type { Message, TelegramClient, User } from '@mtcute/node';
import { readStringSession } from '@mtcute/node/utils.js';
import { assertTestNetwork, loginTestNumber, makeTestClient } from './spike-login';
import { checkHistory, describeMessage } from './spike-messages';
import { errCode, loadCredentials, out, sleep, waiter } from './spike-util';
import { tryViaBot, tryBotFather } from './spike-bots';

const WAIT_MS = 20_000;

async function main(): Promise<void> {
  out('node.version.major', Number(process.versions.node.split('.')[0]));
  out('module.isCjs', typeof require === 'function' && typeof module === 'object');
  const creds = loadCredentials();
  out('credentials.loaded', true);

  const a = makeTestClient(creds);
  const b = makeTestClient(creds);
  const clients: TelegramClient[] = [a, b];
  try {
    const dcA = await assertTestNetwork(a, 'A');
    const dcB = await assertTestNetwork(b, 'B');
    const loginA = await loginTestNumber(a, dcA, 'A');
    const loginB = await loginTestNumber(b, dcB, 'B');
    await a.startUpdatesLoop();
    await b.startUpdatesLoop();
    const meA = await a.getMe();
    const meB = await b.getMe();
    out('A.me.isBot', meA.isBot);
    out('A.differsFromB', meA.id !== meB.id);

    // --- updates on B (item 4) ---
    const newOnB: Message[] = [];
    const editOnB: Message[] = [];
    const newWaiters: { push(m: Message): void }[] = [];
    const editWaiters: { push(m: Message): void }[] = [];
    b.onNewMessage.add((m) => {
      newOnB.push(m);
      newWaiters.forEach((w) => w.push(m));
    });
    b.onEditMessage.add((m) => {
      editOnB.push(m);
      editWaiters.forEach((w) => w.push(m));
    });
    const expectNew = (pred: (m: Message) => boolean) => {
      const w = waiter<Message>(pred, WAIT_MS);
      newWaiters.push(w);
      return w.promise;
    };
    const fromA = (m: Message) => m.sender.id === meA.id;

    // A must know B's access hash: import B as a contact by its test number.
    const imported = await a.importContacts([
      { phone: loginB.phone, firstName: 'Spike', lastName: 'B' },
    ]);
    out('A.importContacts.users', imported.users.length);
    const peerB = meB.id;

    // 1) plain message
    const plainText = 'S0 spike plain message';
    const gotPlain = expectNew((m) => fromA(m) && m.text === plainText && m.forward === null);
    await a.sendText(peerB, plainText);
    const plain = await gotPlain;
    out('upd.plain.received', plain !== null);
    if (plain) describeMessage('upd.plain', plain, meA.id, meA.id);

    // 2) forwarded message (source = A's Saved Messages, 2 s older than the forward)
    const src = await a.sendText('me', 'S0 spike forward source');
    await sleep(2_100);
    const gotFwd = expectNew((m) => fromA(m) && m.forward !== null);
    await a.forwardMessagesById({ toChatId: peerB, fromChatId: 'me', messages: [src.id] });
    const fwd = await gotFwd;
    out('upd.forward.received', fwd !== null);
    if (fwd) describeMessage('upd.forward', fwd, meA.id, meA.id);

    // 3) message that is edited afterwards
    const editText = 'S0 spike to be edited';
    const gotToEdit = expectNew((m) => fromA(m) && m.text === editText);
    const sentToEdit = await a.sendText(peerB, editText);
    const toEdit = await gotToEdit;
    out('upd.toEdit.received', toEdit !== null);
    await sleep(2_100);
    const gotEdit = waiter<Message>((m) => fromA(m) && m.editDate !== null, WAIT_MS);
    editWaiters.push(gotEdit);
    await a.editMessage({ chatId: peerB, message: sentToEdit.id, text: 'S0 spike edited' });
    const edited = await gotEdit.promise;
    out('upd.edit.receivedViaOnEditMessage', edited !== null);
    if (edited) {
      describeMessage('upd.edited', edited, meA.id, meA.id);
      out('upd.edited.sameIdAsOriginal', toEdit !== null && edited.id === toEdit.id);
      out(
        'upd.edited.dateUnchanged',
        toEdit !== null && edited.date.getTime() === toEdit.date.getTime(),
      );
      out(
        'upd.edited.editDate>date',
        edited.editDate !== null && edited.editDate.getTime() > edited.date.getTime(),
      );
    }

    // 4) via inline bot (may be impossible on test DC: reported honestly)
    const via = await tryViaBot(a, peerB, (pred) => expectNew((m) => fromA(m) && pred(m)));
    if (via) describeMessage('upd.viaBot', via, meA.id, meA.id);

    out('upd.B.newMessageEvents', newOnB.length);
    out('upd.B.editEvents', editOnB.length);

    // --- history on B (item 3) ---
    const knownIds = [plain, fwd, toEdit, via]
      .filter((m): m is Message => m !== null)
      .map((m) => m.id);
    const hist = await checkHistory('hist.BfromA', b, meA.id, knownIds);
    const histEdited = hist.find((m) => toEdit !== null && m.id === toEdit.id);
    if (histEdited) describeMessage('hist.edited', histEdited, meA.id, meA.id);
    const histFwd = hist.find((m) => fwd !== null && m.id === fwd.id);
    if (histFwd) describeMessage('hist.forward', histFwd, meA.id, meA.id);

    // --- a real bot private chat (sender.isBot=true), like the bank bots ---
    await tryBotFather(a);

    // --- account.getAuthorizations (item 5) ---
    const auths = await a.call({ _: 'account.getAuthorizations' });
    out('auth.raw._', `const:${auths._}`);
    out('auth.count', auths.authorizations.length);
    out('auth.ttlDays.type', `type:${typeof auths.authorizationTtlDays}`);
    out('auth.currentCount', auths.authorizations.filter((x) => x.current === true).length);
    const first = auths.authorizations[0];
    if (first) {
      out('auth.item.keys', Object.keys(first).sort());
      out('auth.item.hash.type', `type:${first.hash.constructor.name}`);
      out('auth.item.dateCreated.type', `type:${typeof first.dateCreated}`);
      out(
        'auth.item.apiIdMatchesOurs',
        auths.authorizations.some((x) => x.current === true && x.apiId === creds.apiId),
      );
    }

    // --- session export / import (item 2) ---
    await sessionRoundTrip(a, meA, creds);

    out('loginA.newlyRegistered', loginA.newlyRegistered);
    out('loginB.newlyRegistered', loginB.newlyRegistered);
  } finally {
    for (const [i, c] of clients.entries()) {
      try {
        await c.logOut();
        out(`logout.${i === 0 ? 'A' : 'B'}`, true);
      } catch (e) {
        out(`logout.${i === 0 ? 'A' : 'B'}.error`, `const:${errCode(e)}`);
      }
      await c.destroy();
    }
  }
}

async function sessionRoundTrip(
  a: TelegramClient,
  meA: User,
  creds: ReturnType<typeof loadCredentials>,
) {
  const session = await a.exportSession();
  out('session.length', session.length);
  out('session.isBase64Url', /^[A-Za-z0-9_-]+$/.test(session));
  const parsed = readStringSession(session);
  out('session.version', parsed.version);
  out('session.primaryDcs.main.testMode', parsed.primaryDcs.main.testMode === true);
  out('session.primaryDcs.main.id', parsed.primaryDcs.main.id);
  out('session.authKey.length', parsed.authKey.length);
  out('session.self.present', parsed.self !== null && parsed.self !== undefined);
  out('session.self.keys', parsed.self ? Object.keys(parsed.self).sort() : []);

  const c = makeTestClient(creds);
  try {
    await c.importSession(session);
    const meC = await c.getMe();
    out('session.import.sameUser', meC.id === meA.id);
    out('session.import.reExportEqual', (await c.exportSession()) === session);
  } finally {
    await c.destroy(); // no logOut: it shares A's auth key, A logs out at the end
  }
}

main().then(
  () => {
    out('spike.finished', true);
    process.exit(0);
  },
  (e: unknown) => {
    out('spike.failed', `const:${errCode(e)}`);
    if (e instanceof Error && e.message.startsWith('ABORT')) out('spike.aborted', true);
    process.exit(1);
  },
);
