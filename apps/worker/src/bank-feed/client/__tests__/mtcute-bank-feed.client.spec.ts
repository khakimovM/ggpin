import { Logger } from '@nestjs/common';
import type { BankFeedSource } from '@repo/shared';
import {
  BankFeedFatalError,
  BankFeedNotConnectedError,
  type BankFeedMessage,
  type BankFeedNudge,
} from '../bank-feed-client';
import { MtcuteBankFeedClient, label } from '../mtcute-bank-feed.client';
import { describeBankFeedClientContract } from './bank-feed-client.contract';
import { FakeRpcError, FakeTelegram, authorization, mtMessage } from './fake-mtcute';

const UZCARD = 900_000_001; // the contract suite's bot
const HUMO = 900_000_002;
const BOTS: Record<BankFeedSource, bigint> = { HUMO_BOT: BigInt(HUMO), UZCARD_BOT: BigInt(UZCARD) };
const SESSION = 'TESTSESSION_plaintext';

function toMt(m: BankFeedMessage) {
  return mtMessage(Number(m.id), Number(m.chatId), { date: Math.floor(m.date.getTime() / 1000) });
}

function setup() {
  const tg = new FakeTelegram();
  tg.users = [
    { id: HUMO, isBot: true, username: 'HUMOcardbot' },
    { id: UZCARD, isBot: true, username: 'CardXabarBot' },
  ];
  const client = new MtcuteBankFeedClient(tg, { bots: BOTS, openSession: () => SESSION });
  return { tg, client };
}

// The fetchSince contract the re-scan relies on, against the mtcute client over a history that
// behaves like mtcute's getHistory(reverse) (S9-L2). The real server is checked in S11.
describeBankFeedClientContract('MtcuteBankFeedClient (mocked TelegramClient)', async () => {
  const { tg, client } = setup();
  await client.start();
  return {
    client,
    seed: (_source, messages) => {
      for (const m of messages) tg.put(Number(m.chatId), toMt(m));
      return Promise.resolve();
    },
    seedOtherChat: (messages) => {
      for (const m of messages) tg.put(Number(m.chatId), toMt(m));
      return Promise.resolve();
    },
  };
});

describe('MtcuteBankFeedClient', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('pages history with reverse + offset minId+1 (inclusive) on the pinned peer only', async () => {
    const { tg, client } = setup();
    tg.put(UZCARD, mtMessage(10, UZCARD));
    tg.put(UZCARD, mtMessage(11, UZCARD));
    await client.start();
    const page = await client.fetchSince('UZCARD_BOT', 10n, 100);
    expect(page.map((m) => m.id)).toEqual([11n]);
    expect(tg.historyCalls).toEqual([
      { peer: UZCARD, params: { reverse: true, offset: { id: 11, date: 0 }, limit: 100 } },
    ]);
    expect(page[0]).toMatchObject({ chatId: BigInt(UZCARD), senderIsBot: true });
  });

  it('start: opens the session, warms the peer cache, checks both pinned bots, reports the account', async () => {
    const { tg, client } = setup();
    await expect(client.start()).resolves.toEqual({ accountId: 7_000_000_001n });
    expect(tg.resumedWith).toEqual([SESSION]);
    expect(tg.warmed).toBe(1);
  });

  it('r2 I-4: the account is verified right after getMe, before the updates loop, the dialogs and the bots', async () => {
    const { tg, client } = setup();
    const seen: string[] = [];
    const verify = (accountId: bigint) => {
      seen.push(`verify:${accountId.toString()} begun=${tg.begun} warmed=${tg.warmed}`);
      return Promise.resolve();
    };
    await client.start(verify);
    expect(seen).toEqual(['verify:7000000001 begun=0 warmed=0']);
    expect([tg.begun, tg.warmed]).toEqual([1, 1]);
    // A refused account: nothing else of it is read, and no updates loop runs.
    const other = setup();
    const refused = new BankFeedFatalError('ACCOUNT_MISMATCH');
    await expect(other.client.start(() => Promise.reject(refused))).rejects.toBe(refused);
    expect([other.tg.begun, other.tg.warmed]).toEqual([0, 0]);
    await expect(other.client.listAuthorizations()).rejects.toBeInstanceOf(
      BankFeedNotConnectedError,
    );
  });

  it('r2 I-5: device labels lose C0/C1 controls and bidi marks, are trimmed and cut to 128', () => {
    expect(label('Te\u0000st‮ Desk⁦top\u0085 ')).toBe('Test Desktop');
    expect(label('‏؜\u007f')).toBeNull();
    expect(label(undefined)).toBeNull();
    expect(label('x'.repeat(200))).toHaveLength(128);
    expect(label('Тест ПК')).toBe('Тест ПК');
  });

  it('D-52: no read reaches Telegram unless started (and not stopped): mtcute would reconnect by itself', async () => {
    const { tg, client } = setup();
    tg.put(HUMO, mtMessage(5, HUMO));
    await expect(client.fetchSince('HUMO_BOT', 0n, 10)).rejects.toBeInstanceOf(
      BankFeedNotConnectedError,
    );
    await expect(client.listAuthorizations()).rejects.toBeInstanceOf(BankFeedNotConnectedError);
    await expect(client.latestMessageId('HUMO_BOT')).rejects.toBeInstanceOf(
      BankFeedNotConnectedError,
    );
    await client.start();
    await expect(client.latestMessageId('HUMO_BOT')).resolves.toBe(5n);
    await client.stop();
    await expect(client.fetchSince('HUMO_BOT', 0n, 10)).rejects.toBeInstanceOf(
      BankFeedNotConnectedError,
    );
    tg.users = [];
    await expect(client.start()).rejects.toEqual(new BankFeedFatalError('BOT_MISMATCH'));
    await expect(client.listAuthorizations()).rejects.toBeInstanceOf(BankFeedNotConnectedError);
    expect(tg.historyCalls).toEqual([]);
    expect(tg.latestCalls).toEqual([HUMO]);
  });

  it.each([
    ['not a bot', { id: HUMO, isBot: false, username: 'HUMOcardbot' }],
    ['another username', { id: HUMO, isBot: true, username: 'HUMOcardb0t' }],
    ['unknown id', null],
  ])('start refuses a pinned Humo bot that is %s: BOT_MISMATCH', async (_label, humo) => {
    const { tg, client } = setup();
    tg.users = [humo, { id: UZCARD, isBot: true, username: 'cardxabarbot' }];
    await expect(client.start()).rejects.toEqual(new BankFeedFatalError('BOT_MISMATCH'));
  });

  it('S9 B2: updates of another chat are dropped before anything of them is read', async () => {
    const { tg, client } = setup();
    const nudges: BankFeedNudge[] = [];
    client.onNewMessage((n) => nudges.push(n));
    await client.start();
    let touched = false;
    const foreign = {
      raw: {
        _: 'message',
        id: 5,
        date: 1,
        peerId: { _: 'peerUser', userId: 555 },
        get message() {
          touched = true;
          return 'private words';
        },
      },
      get sender() {
        touched = true;
        return { type: 'user', id: 555 };
      },
    };
    tg.onNewMessage.emit(foreign);
    tg.onNewMessage.emit(mtMessage(6, UZCARD));
    expect(nudges).toEqual([{ source: 'UZCARD_BOT', messageId: 6n }]);
    expect(touched).toBe(false);
  });

  it('edits arrive on onEditMessage and are passed on as edit nudges', async () => {
    const { tg, client } = setup();
    const edits: BankFeedNudge[] = [];
    const news: BankFeedNudge[] = [];
    client.onEditMessage((n) => edits.push(n));
    client.onNewMessage((n) => news.push(n));
    await client.start();
    tg.onEditMessage.emit(mtMessage(7, HUMO, { editDate: 1_900_000_999 }));
    expect(edits).toEqual([{ source: 'HUMO_BOT', messageId: 7n }]);
    expect(news).toEqual([]);
  });

  it.each([
    ['AUTH_KEY_UNREGISTERED', 'REVOKED'],
    ['SESSION_REVOKED', 'REVOKED'],
    ['USER_DEACTIVATED', 'BANNED'],
    ['USER_DEACTIVATED_BAN', 'BANNED'],
    ['AUTH_KEY_DUPLICATED', 'DUPLICATED'],
  ] as const)('%s from a call is BankFeedFatalError %s', async (text, code) => {
    const { tg, client } = setup();
    await client.start();
    tg.failNext = new FakeRpcError(text);
    await expect(client.fetchSince('HUMO_BOT', 0n, 10)).rejects.toEqual(
      new BankFeedFatalError(code),
    );
  });

  it('fatal errors of the updates loop go to onFatal; others are logged by code once an hour', async () => {
    const { tg, client } = setup();
    const fatal: BankFeedFatalError[] = [];
    client.onFatal((e) => fatal.push(e));
    await client.start();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    tg.onError.emit(new FakeRpcError('AUTH_KEY_DUPLICATED', 406));
    tg.onError.emit(new FakeRpcError('FLOOD_WAIT_25', 420));
    tg.onError.emit(new FakeRpcError('FLOOD_WAIT_25', 420));
    expect(fatal.map((e) => e.code)).toEqual(['DUPLICATED']);
    expect(warn.mock.calls).toEqual([['mtcute error: rpc:FLOOD_WAIT_N']]);
    warn.mockRestore();
  });

  it('listAuthorizations keeps hash, current, date and the device labels: never ip, country or region', async () => {
    const { tg, client } = setup();
    await client.start();
    tg.authorizations = [
      authorization(0n, { current: true, dateCreated: 0, appName: '' }),
      authorization(18_446_744_073_709_551_000n, { deviceModel: 'X'.repeat(300) }),
    ];
    const list = await client.listAuthorizations();
    expect(list).toEqual([
      { hash: '0', current: true, createdAt: null, appName: null, deviceModel: 'Test PC' },
      {
        hash: '18446744073709551000',
        current: false,
        createdAt: new Date(1_900_000_000 * 1000),
        appName: 'Test Desktop',
        deviceModel: 'X'.repeat(128),
      },
    ]);
    expect(JSON.stringify(list.map((a) => ({ ...a, createdAt: 0 })))).not.toMatch(
      /203\.0\.113|Testland|Test Region/,
    );
  });

  it('stop disconnects reversibly; close destroys once and unsubscribes', async () => {
    const { tg, client } = setup();
    await client.start();
    await client.stop();
    expect(tg.paused).toBe(1);
    expect(tg.onNewMessage.listeners).toHaveLength(0);
    await client.start();
    expect(tg.onNewMessage.listeners).toHaveLength(1);
    await client.close();
    await client.close();
    expect(tg.destroyed).toBe(1);
    expect(tg.onEditMessage.listeners).toHaveLength(0);
    await expect(client.start()).rejects.toThrow('closed');
  });
});
