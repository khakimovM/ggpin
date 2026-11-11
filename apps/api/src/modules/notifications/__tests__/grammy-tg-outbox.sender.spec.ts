import { Api } from 'grammy';
import type { TgOutboxJob } from '@repo/shared';
import type { AppConfig } from '../../../config/config.module';
import { TEST_BOT_TOKEN } from '../../../config/__tests__/test-env';
import { GrammyTgOutboxSender } from '../grammy-tg-outbox.sender';

describe('GrammyTgOutboxSender', () => {
  it('sends HTML with link previews disabled, so a URL in a message is never expanded', async () => {
    const sendMessage = jest.spyOn(Api.prototype, 'sendMessage').mockResolvedValue({} as never);
    try {
      const sender = new GrammyTgOutboxSender({ TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN } as AppConfig);
      const job: TgOutboxJob = { chatId: '777', text: 'see https://evil.example' };
      await sender.send(job);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith('777', 'see https://evil.example', {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } finally {
      sendMessage.mockRestore();
    }
  });

  it('passes a web_app inline keyboard through as reply_markup', async () => {
    const sendMessage = jest.spyOn(Api.prototype, 'sendMessage').mockResolvedValue({} as never);
    try {
      const sender = new GrammyTgOutboxSender({ TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN } as AppConfig);
      const replyMarkup = {
        inline_keyboard: [
          [{ text: 'Top up', web_app: { url: 'https://app.ggpin.test/tg/topup' } }],
        ],
      };
      await sender.send({ chatId: '777', text: 'ok', replyMarkup });
      expect(sendMessage).toHaveBeenCalledWith('777', 'ok', {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkup,
      });
    } finally {
      sendMessage.mockRestore();
    }
  });
});
