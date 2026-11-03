import { BotSetupService } from '../bot-setup.service';
import { createFakeTelegram } from './fake-telegram-api';

const MINI_APP = { MINI_APP_URL: 'https://app.example.test/tg' };

describe('BotSetupService', () => {
  it('sets commands for uz, ru and the default (uz)', async () => {
    const fake = createFakeTelegram();
    await new BotSetupService(fake.bot, MINI_APP).run();
    const commands = fake.callsOf('setMyCommands').map((c) => c.payload);
    expect(commands.map((c) => c['language_code'])).toEqual(['uz', 'ru', undefined]);
    expect(commands[2]?.['commands']).toEqual(commands[0]?.['commands']);
    expect(commands).toMatchSnapshot();
  });

  it('sets a web_app default menu button when MINI_APP_URL is set', async () => {
    const fake = createFakeTelegram();
    await new BotSetupService(fake.bot, MINI_APP).run();
    expect(fake.callsOf('setChatMenuButton').map((c) => c.payload)).toMatchSnapshot();
  });

  it('sets no web_app button at all when MINI_APP_URL is unset', async () => {
    const fake = createFakeTelegram();
    const setup = new BotSetupService(fake.bot, { MINI_APP_URL: undefined });
    await setup.run();
    await setup.setForChat(42, 'ru');
    expect(JSON.stringify(fake.calls)).not.toContain('web_app');
    expect(fake.callsOf('setChatMenuButton').map((c) => c.payload)).toEqual([
      { menu_button: { type: 'default' } },
    ]);
  });

  it('localizes the per-chat button', async () => {
    const fake = createFakeTelegram();
    const setup = new BotSetupService(fake.bot, MINI_APP);
    await setup.setForChat(42, 'ru');
    await setup.setForChat(43, 'uz');
    expect(fake.callsOf('setChatMenuButton').map((c) => c.payload)).toMatchSnapshot();
  });

  it('never throws when Telegram fails', async () => {
    const fake = createFakeTelegram();
    fake.failMethod('setMyCommands');
    fake.failMethod('setChatMenuButton');
    const setup = new BotSetupService(fake.bot, MINI_APP);
    await expect(setup.run()).resolves.toBeUndefined();
    await expect(setup.setForChat(1, 'uz')).resolves.toBeUndefined();
  });
});
