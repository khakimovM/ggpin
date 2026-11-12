import { describe, expect, it } from 'vitest';
import { siteLinks } from '../site-links';

const SET = {
  NEXT_PUBLIC_BOT_USERNAME: 'ggpin_bot',
  NEXT_PUBLIC_TELEGRAM_CHANNEL_URL: 'https://t.me/ggpin_channel',
  NEXT_PUBLIC_SUPPORT_URL: 'https://t.me/ggpin_support',
};

describe('siteLinks', () => {
  it('builds every link from configuration', () => {
    expect(siteLinks(SET)).toEqual({
      bot: 'https://t.me/ggpin_bot',
      botHandle: '@ggpin_bot',
      channel: 'https://t.me/ggpin_channel',
      support: 'https://t.me/ggpin_support',
    });
  });

  it('an empty setting gives no link, so the page draws none', () => {
    expect(
      siteLinks({
        NEXT_PUBLIC_BOT_USERNAME: '',
        NEXT_PUBLIC_TELEGRAM_CHANNEL_URL: '',
        NEXT_PUBLIC_SUPPORT_URL: '',
      }),
    ).toEqual({ bot: null, botHandle: null, channel: null, support: null });
  });

  it('each link is independent of the others', () => {
    const links = siteLinks({ ...SET, NEXT_PUBLIC_TELEGRAM_CHANNEL_URL: '' });
    expect(links.channel).toBeNull();
    expect(links.bot).not.toBeNull();
    expect(links.support).not.toBeNull();
  });

  it('a channel that is not on t.me is dropped even if the configuration let it through', () => {
    expect(
      siteLinks({ ...SET, NEXT_PUBLIC_TELEGRAM_CHANNEL_URL: 'https://t.me.evil.example/x' })
        .channel,
    ).toBeNull();
    expect(
      siteLinks({ ...SET, NEXT_PUBLIC_TELEGRAM_CHANNEL_URL: 'javascript:alert(1)' }).channel,
    ).toBeNull();
  });

  it('a support link that is not http(s) is dropped', () => {
    expect(
      siteLinks({ ...SET, NEXT_PUBLIC_SUPPORT_URL: 'javascript:alert(1)' }).support,
    ).toBeNull();
  });
});
