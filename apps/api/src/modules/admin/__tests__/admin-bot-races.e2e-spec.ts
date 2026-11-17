import { createFakeTelegram } from '../../telegram/__tests__/fake-telegram-api';
import { textUpdate } from '../../telegram/__tests__/updates';
import { maskTelegramId } from '../admins/admin-allowlist';
import { AdminUsersRepository } from '../admins/admin-users.repository';
import { useAdminE2e } from './admin-e2e.harness';
import { heldTransaction, waitForLockWaiter } from './admin-e2e.locks';

// The bot's code issuing against a deactivation, through the real webhook and wiring; only the Bot
// API transport is fake. The interleaving is chosen by the test: a holder transaction keeps the
// admin row locked as admin:deactivate does, and commits once Postgres reports the bot waiting.
describe('admin code issuing races (real app, fake Bot API, real row locks)', () => {
  const fake = createFakeTelegram();
  const t = useAdminE2e({ bot: fake });
  const repo = () => t.app().get(AdminUsersRepository);
  const sentTo = (chatId: number) =>
    fake
      .callsOf('sendMessage')
      .filter((c) => c.payload['chat_id'] === chatId)
      .map(({ payload: { chat_id: _chat, ...rest } }) => rest);
  const refusals = (telegramId: bigint) =>
    t.logs
      .text()
      .split('\n')
      .filter((l) =>
        l.includes(`event=ADMIN_CODE_REFUSED telegramId=${maskTelegramId(telegramId)}`),
      );

  it('the bot waits for a deactivation holding the admin row, then answers like any non-admin: no code', async () => {
    const op = await t.newAdmin('OPERATOR');
    const id = Number(op.telegramId);
    const nonce = await t.start();
    const holder = await heldTransaction(t.db(), (tx) => repo().deactivate(tx, op.id));

    let settled = false;
    const update = t.webhook(textUpdate({ id }, `/start admin_${nonce}`)).finally(() => {
      settled = true;
    });
    const waited = await waitForLockWaiter(t.db(), '%"AdminUser"%FOR SHARE%', () => settled);
    await holder.commit();
    const res = await update;

    expect(waited).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(await t.db().loginRequest.findUniqueOrThrow({ where: { nonce } })).toMatchObject({
      status: 'PENDING',
      telegramId: null,
      codeHash: null,
    });
    expect(refusals(op.telegramId)).toHaveLength(1);

    // The very same answer an already inactive admin gets: no new oracle.
    const control = await t.newAdmin('OPERATOR', { active: false });
    await t.webhook(
      textUpdate({ id: Number(control.telegramId) }, `/start admin_${await t.start()}`),
    );
    const answer = sentTo(id);
    expect(answer).toHaveLength(1);
    expect(answer).toEqual(sentTo(Number(control.telegramId)));
    expect(JSON.stringify(answer)).not.toMatch(/<code>\d{6}<\/code>/);
  });
});
