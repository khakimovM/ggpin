import { ingestRejectReason } from '../ingest-filter';
import { BankFeedSenderUnknownError, peerIdOf, toBankFeedMessage } from '../mtcute-message';
import { mtMessage } from './fake-mtcute';

const BOT = 900_000_001;
const SELF = 900_000_500;

describe('toBankFeedMessage (mtcute raw fields -> BankFeedMessage)', () => {
  it('a plain notification of the bot: every field, accepted by the filter', () => {
    const m = toBankFeedMessage(mtMessage(41, BOT, { date: 1_900_000_100 }));
    expect(m).toEqual({
      id: 41n,
      date: new Date(1_900_000_100 * 1000),
      chatId: BigInt(BOT),
      senderId: BigInt(BOT),
      senderIsBot: true,
      text: 'synthetic',
      outgoing: false,
      forwarded: false,
      editDate: null,
      viaBotId: null,
    });
    expect(ingestRejectReason(m, BigInt(BOT))).toBeNull();
  });

  it('S9 security I1: date is message.date (sent), not the edit time nor the forward origin', () => {
    const edited = toBankFeedMessage(
      mtMessage(42, BOT, { date: 1_900_000_100, editDate: 1_900_000_900 }),
    );
    expect(edited.date).toEqual(new Date(1_900_000_100 * 1000));
    expect(edited.editDate).toEqual(new Date(1_900_000_900 * 1000));
    const forwarded = toBankFeedMessage(
      mtMessage(43, BOT, {
        date: 1_900_000_200,
        fwdFrom: { _: 'messageFwdHeader', date: 1_800_000_000 },
      }),
    );
    expect(forwarded.date).toEqual(new Date(1_900_000_200 * 1000));
    expect(forwarded.forwarded).toBe(true);
  });

  it('forward, edit, via bot, via business bot, outgoing: each refused by the filter', () => {
    const pinned = BigInt(BOT);
    const reason = (options: Parameters<typeof mtMessage>[2]) =>
      ingestRejectReason(toBankFeedMessage(mtMessage(50, BOT, options)), pinned);
    expect(reason({ fwdFrom: { _: 'messageFwdHeader' } })).toBe('FORWARDED');
    expect(reason({ editDate: 1_900_000_999 })).toBe('EDITED');
    expect(reason({ viaBotId: 777 })).toBe('VIA_BOT');
    expect(reason({ viaBusinessBotId: 778 })).toBe('VIA_BOT');
    expect(reason({ out: true, fromId: { _: 'peerUser', userId: SELF } })).toBe('OUTGOING');
  });

  it('sender: fromId when present, else the chat user; isBot only from a user sender with that id', () => {
    const pinned = BigInt(BOT);
    const other = toBankFeedMessage(
      mtMessage(60, BOT, {
        fromId: { _: 'peerUser', userId: 123 },
        sender: { type: 'user', id: 123, isBot: true },
      }),
    );
    expect(other.senderId).toBe(123n);
    expect(ingestRejectReason(other, pinned)).toBe('FOREIGN_SENDER');
    const human = toBankFeedMessage(
      mtMessage(61, BOT, { sender: { type: 'user', id: BOT, isBot: false } }),
    );
    expect(ingestRejectReason(human, pinned)).toBe('NOT_BOT');
    const chatSender = toBankFeedMessage(mtMessage(62, BOT, { sender: { type: 'chat', id: BOT } }));
    expect(chatSender.senderIsBot).toBe(false);
  });

  it('D-52 r2 M-B: an unknown sender of the bot chat is a client error (the page fails), not NOT_BOT', () => {
    const throwing = () => {
      throw new Error('peer not found');
    };
    // The bot's own message: no anomaly, no stored row: the poll fails and the cursor stays.
    expect(() => toBankFeedMessage(mtMessage(63, BOT, { sender: throwing }))).toThrow(
      BankFeedSenderUnknownError,
    );
    // Our own message or another sender's: the filter refuses it first, the flag is just false.
    const own = toBankFeedMessage(
      mtMessage(64, BOT, { out: true, fromId: { _: 'peerUser', userId: SELF }, sender: throwing }),
    );
    expect(own.senderIsBot).toBe(false);
    expect(ingestRejectReason(own, BigInt(BOT))).toBe('OUTGOING');
    const foreign = toBankFeedMessage(
      mtMessage(65, BOT, { fromId: { _: 'peerUser', userId: 123 }, sender: throwing }),
    );
    expect(ingestRejectReason(foreign, BigInt(BOT))).toBe('FOREIGN_SENDER');
  });

  it('another chat (group, channel, another user) never has the bot chat id', () => {
    expect(peerIdOf({ _: 'peerChat', chatId: BOT })).toBe(-BigInt(BOT));
    expect(peerIdOf({ _: 'peerChannel', channelId: BOT })).toBe(
      -(1_000_000_000_000n + BigInt(BOT)),
    );
    expect(peerIdOf({ _: 'peerUnknown' })).toBe(-1n);
    const group = toBankFeedMessage(mtMessage(70, BOT, { peerId: { _: 'peerChat', chatId: BOT } }));
    expect(ingestRejectReason(group, BigInt(BOT))).toBe('FOREIGN_CHAT');
  });

  it('S6: media is not parsed (empty text -> UNRECOGNIZED review); a link preview keeps its text', () => {
    const photo = toBankFeedMessage(
      mtMessage(80, BOT, { media: { _: 'messageMediaPhoto' }, message: 'caption text' }),
    );
    expect(photo.text).toBe('');
    const preview = toBankFeedMessage(mtMessage(81, BOT, { media: { _: 'messageMediaWebPage' } }));
    expect(preview.text).toBe('synthetic');
    const service = toBankFeedMessage(mtMessage(82, BOT, { _: 'messageService' }));
    expect(service.text).toBe('');
  });
});
