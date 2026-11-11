import { FakeBankFeedClient } from '../fake-bank-feed.client';
import { describeBankFeedClientContract } from './bank-feed-client.contract';

// The in-memory client keeps the same contract the S7 client must keep (oldest first, empty
// page = end), so the re-scan tests that use it prove the behaviour the real client will get.
describeBankFeedClientContract('FakeBankFeedClient', () => {
  const client = new FakeBankFeedClient();
  return Promise.resolve({
    client,
    seed: (source, messages) => {
      for (const message of messages) client.put(source, message);
      return Promise.resolve();
    },
    seedOtherChat: (messages) => {
      for (const message of messages) client.putOtherChat(message);
      return Promise.resolve();
    },
  });
});
