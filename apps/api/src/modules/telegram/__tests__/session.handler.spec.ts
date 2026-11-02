import { sessionEndCallbackData } from '@repo/shared';
import { createHarness, makeUser } from './bot-harness';
import { callbackUpdate } from './updates';

const ID = 700_401;
const FAMILY = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const data = sessionEndCallbackData(FAMILY);

describe.each(['uz', 'ru'] as const)('end-session button (%s)', (locale) => {
  const users = [makeUser(BigInt(ID), { locale })];

  it('callback_data fits in 64 bytes', () => {
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
  });

  it('an ended session edits the message and removes the button', async () => {
    const h = createHarness({ users });
    await h.send(callbackUpdate({ id: ID }, data));
    expect(h.payloads()).toMatchSnapshot();
    expect(h.endedFamilies).toEqual([FAMILY]);
    expect(h.callsOf('editMessageText')[0]?.payload['reply_markup']).toEqual({
      inline_keyboard: [],
    });
  });

  it('an unknown or foreign session only answers and removes the stale button', async () => {
    const h = createHarness({
      users,
      sessions: { endSessionFromBot: () => Promise.resolve(false) },
    });
    await h.send(callbackUpdate({ id: ID }, data));
    expect(h.payloads()).toMatchSnapshot();
    expect(h.callsOf('editMessageText')).toHaveLength(0);
    expect(h.callsOf('editMessageReplyMarkup')).toHaveLength(1);
  });

  it('never throws when the service fails, and logs only the error name', async () => {
    const h = createHarness({
      users,
      sessions: { endSessionFromBot: () => Promise.reject(new Error(`db down ${FAMILY}`)) },
    });
    await expect(h.send(callbackUpdate({ id: ID }, data))).resolves.toBeUndefined();
    expect(h.logs.warn).toEqual(['session end failed: Error']);
    expect(JSON.stringify(h.logs)).not.toContain(FAMILY);
    expect(h.callsOf('answerCallbackQuery')).toHaveLength(1);
  });

  it.each(['se:short', `se:${FAMILY}x`, `se:${FAMILY.replace(/-/g, '')}`, 'se:../../etc'])(
    'ignores malformed data %s',
    async (bad) => {
      const h = createHarness({ users });
      await h.send(callbackUpdate({ id: ID }, bad));
      expect(h.endedFamilies).toHaveLength(0);
    },
  );
});
