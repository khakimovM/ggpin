import type { BankFeedMessage } from '../bank-feed-client';
import { ingestRejectReason, isForeignText } from '../ingest-filter';

const BOT = 900_000_001n;

function message(over: Partial<BankFeedMessage> = {}): BankFeedMessage {
  return {
    id: 10n,
    date: new Date('2030-05-01T10:00:00.000Z'),
    chatId: BOT,
    senderId: BOT,
    senderIsBot: true,
    text: 'synthetic',
    outgoing: false,
    forwarded: false,
    editDate: null,
    viaBotId: null,
    ...over,
  };
}

describe('ingestRejectReason', () => {
  it('accepts only a fresh message the pinned bot itself sent in its own chat', () => {
    expect(ingestRejectReason(message(), BOT)).toBeNull();
  });

  it.each([
    ['OUTGOING', { outgoing: true }],
    ['FORWARDED', { forwarded: true }],
    ['EDITED', { editDate: new Date('2030-05-01T10:01:00.000Z') }],
    ['VIA_BOT', { viaBotId: 900_000_002n }],
    ['FOREIGN_CHAT', { chatId: 900_000_004n }],
    ['FOREIGN_SENDER', { senderId: 900_000_003n }],
    ['NOT_BOT', { senderIsBot: false }],
  ] as const)('rejects %s', (reason, over) => {
    expect(ingestRejectReason(message(over), BOT)).toBe(reason);
  });

  it('names the first problem when several apply', () => {
    expect(ingestRejectReason(message({ outgoing: true, forwarded: true }), BOT)).toBe('OUTGOING');
    // Another chat wins over everything: such a message is never stored (B2).
    expect(ingestRejectReason(message({ chatId: 7n, forwarded: true }), BOT)).toBe('FOREIGN_CHAT');
    expect(ingestRejectReason(message({ chatId: 7n, outgoing: true }), BOT)).toBe('FOREIGN_CHAT');
    expect(ingestRejectReason(message({ forwarded: true, senderId: 1n }), BOT)).toBe('FORWARDED');
    expect(ingestRejectReason(message({ chatId: 7n, senderId: 7n }), BOT)).toBe('FOREIGN_CHAT');
    expect(ingestRejectReason(message({ senderId: 7n, senderIsBot: false }), BOT)).toBe(
      'FOREIGN_SENDER',
    );
  });
});

describe('isForeignText', () => {
  it('keeps no text for another chat, another sender or a non-bot; keeps it otherwise', () => {
    for (const reason of ['FOREIGN_CHAT', 'FOREIGN_SENDER', 'NOT_BOT'] as const) {
      expect(isForeignText(reason)).toBe(true);
    }
    for (const reason of ['OUTGOING', 'FORWARDED', 'EDITED', 'VIA_BOT', null] as const) {
      expect(isForeignText(reason)).toBe(false);
    }
  });
});
