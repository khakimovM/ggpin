import type { BankFeedSource } from '@repo/shared';
import type { BankFeedClient, BankFeedMessage } from '../bank-feed-client';

/**
 * The `fetchSince` contract the daily re-scan relies on (bank-feed-client.ts), as one suite any
 * implementation runs: the fake now, the S7 mtcute client against its recorded fixtures later.
 * `seed` puts these messages into the source's chat (ids ascending, all after `minId`);
 * `seedOtherChat` puts them into a chat that is not any source's bot chat (a group, a person).
 */
export interface ContractSubject {
  readonly client: BankFeedClient;
  seed(source: BankFeedSource, messages: readonly BankFeedMessage[]): Promise<void>;
  seedOtherChat(messages: readonly BankFeedMessage[]): Promise<void>;
}

const BOT = 900_000_001n;
const OTHER_CHAT = 900_000_777n;
const MIN_ID = 1_000n;

function synthetic(id: bigint): BankFeedMessage {
  return {
    id,
    date: new Date(Date.UTC(2030, 4, 1, 10, 0, Number(id % 60n))),
    chatId: BOT,
    senderId: BOT,
    senderIsBot: true,
    text: 'synthetic',
    outgoing: false,
    forwarded: false,
    editDate: null,
    viaBotId: null,
  };
}

export function describeBankFeedClientContract(
  name: string,
  make: () => Promise<ContractSubject>,
): void {
  describe(`${name}: BankFeedClient.fetchSince contract`, () => {
    const ids = Array.from({ length: 250 }, (_, i) => MIN_ID + BigInt(i + 1));

    it('250 messages after minId: the first page is the OLDEST 100, ascending', async () => {
      const subject = await make();
      await subject.seed('UZCARD_BOT', ids.map(synthetic));
      const page = await subject.client.fetchSince('UZCARD_BOT', MIN_ID, 100);
      expect(page.map((m) => m.id)).toEqual(ids.slice(0, 100));
    });

    it('pages by the last id until an EMPTY page; a short page is not the end signal', async () => {
      const subject = await make();
      await subject.seed('UZCARD_BOT', ids.map(synthetic));
      const seen: bigint[] = [];
      let cursor = MIN_ID;
      let pages = 0;
      for (;;) {
        const page = await subject.client.fetchSince('UZCARD_BOT', cursor, 100);
        pages += 1;
        if (page.length === 0) break;
        expect(page.length).toBeLessThanOrEqual(100);
        seen.push(...page.map((m) => m.id));
        cursor = page[page.length - 1]?.id ?? cursor;
      }
      expect(seen).toEqual(ids);
      expect(pages).toBe(4); // 100 + 100 + 50 + the empty page
    });

    it('returns nothing at or below minId and nothing of another source', async () => {
      const subject = await make();
      await subject.seed('UZCARD_BOT', ids.map(synthetic));
      const last = ids[ids.length - 1] ?? MIN_ID;
      expect(await subject.client.fetchSince('UZCARD_BOT', last, 100)).toEqual([]);
      expect(await subject.client.fetchSince('HUMO_BOT', 0n, 100)).toEqual([]);
    });

    it('S9F-I2: never a message of another chat, even with ids next to the bot chat ids', async () => {
      const subject = await make();
      const own = ids.slice(0, 10);
      await subject.seed('UZCARD_BOT', own.map(synthetic));
      // Ids are one sequence per account, so another chat's ids fall between the bot's.
      const other = own.map((id) => ({ ...synthetic(id + 100_000n), chatId: OTHER_CHAT }));
      await subject.seedOtherChat(other);
      const page = await subject.client.fetchSince('UZCARD_BOT', MIN_ID, 100);
      expect(page.map((m) => m.id)).toEqual(own);
      expect(page.every((m) => m.chatId === BOT)).toBe(true);
      expect(await subject.client.fetchSince('HUMO_BOT', 0n, 100)).toEqual([]);
    });
  });
}
