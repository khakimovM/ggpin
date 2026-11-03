import { createHarness, makeUser, NOW } from './bot-harness';
import { myChatMemberUpdate } from './updates';

const ID = 700_301;

describe('my_chat_member', () => {
  it('kicked marks botBlockedAt, never touches isBlocked, sends nothing', async () => {
    const h = createHarness({ users: [makeUser(BigInt(ID))] });
    await h.send(myChatMemberUpdate({ id: ID }, 'kicked'));
    const user = h.store.get(BigInt(ID));
    expect(user?.botBlockedAt).toEqual(NOW);
    expect(user?.isBlocked).toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it('member clears botBlockedAt', async () => {
    const h = createHarness({ users: [makeUser(BigInt(ID), { botBlockedAt: new Date() })] });
    await h.send(myChatMemberUpdate({ id: ID }, 'member'));
    expect(h.store.get(BigInt(ID))?.botBlockedAt).toBeNull();
  });

  it('does not create a user for an unknown id', async () => {
    const h = createHarness();
    await h.send(myChatMemberUpdate({ id: ID }, 'kicked'));
    expect(h.store.size).toBe(0);
  });
});
