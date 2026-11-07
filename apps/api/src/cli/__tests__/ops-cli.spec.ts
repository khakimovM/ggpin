import { AppError } from '../../common/exceptions/app-error';
import { CardAdminService } from '../../modules/payments/card-admin.service';
import { ReviewService } from '../../modules/payments/review.service';
import { WalletAdminService } from '../../modules/wallet/wallet-admin.service';
import { terminalLines, terminalSafe } from '../cli-io';
import { OPS_COMMANDS, helpText } from '../ops-cli.runner';
import { NOOP_CHANGE, WHO, runFake as run } from './fake-cli';

describe('owner CLI (no database)', () => {
  it('lists every command of the plan in its help (English, internal tool)', () => {
    const names = OPS_COMMANDS.map((c) => c.name);
    expect(names).toEqual([
      'review:list',
      'review:show',
      'review:credit',
      'review:ignore',
      'review:returned-offline',
      'review:accept-chain',
      'card:add',
      'card:list',
      'card:retire',
      'card:limit',
      'card:pause',
      'card:resume',
      'wallet:adjust',
      'payment:reverse',
      'user:unfreeze',
    ]);
    const help = helpText().join('\n');
    for (const name of names) expect(help).toContain(name);
    expect(help).toContain('--reason and --operator');
    expect(help).toContain('--env-file-if-exists=.env dist/cli/ops-cli.js');
  });

  it('every changing command refuses to run without --reason or --operator (usage error, service untouched)', async () => {
    const changing = OPS_COMMANDS.filter((c) => c.usage.includes('--reason'));
    expect(changing.length).toBe(12);
    for (const command of changing) {
      const positional = command.usage.startsWith(`${command.name} <`)
        ? ['cm0000000000000000000000']
        : [];
      for (const missing of [
        ['--operator', 'aziz'],
        ['--reason', 'why'],
      ]) {
        const result = await run([command.name, ...positional, ...missing]);
        expect(result.code).toBe(2);
      }
    }
  });

  it('card:add without --limit is a usage error and never reaches the card service', async () => {
    const addCard = jest.fn();
    const services = new Map<unknown, unknown>([[CardAdminService, { addCard }]]);
    const result = await run(['card:add', '--bank', 'HUMO', ...WHO], services);
    expect(result.code).toBe(2);
    expect(result.err.join('\n')).toContain('--limit is required');
    expect(result.asked).toHaveLength(0);
    expect(addCard).not.toHaveBeenCalled();
  });

  it('card:add takes no --pan or --holder on the command line (S8-L4); a bad bank is refused before any question (n7)', async () => {
    const addCard = jest.fn();
    const services = new Map<unknown, unknown>([[CardAdminService, { addCard }]]);
    for (const extra of [
      ['--pan', '9999000000000001'],
      ['--holder', 'TESTOV SINOV'],
    ]) {
      const result = await run(
        ['card:add', '--bank', 'HUMO', '--limit', '100', ...extra, ...WHO],
        services,
      );
      expect(result.code).toBe(2);
      expect(result.asked).toHaveLength(0);
    }
    const badBank = await run(['card:add', '--bank', 'VISA', '--limit', '100', ...WHO], services);
    expect(badBank.code).toBe(1);
    expect(badBank.err[0]).toContain('"field":"bank"');
    expect(badBank.asked).toHaveLength(0);
    expect(addCard).not.toHaveBeenCalled();
  });

  it('an unknown flag or a float-looking amount is a usage error', async () => {
    expect((await run(['review:list', '--everything'])).code).toBe(2);
    const adjust = jest.fn();
    const services = new Map<unknown, unknown>([[WalletAdminService, { adjust }]]);
    for (const amount of ['1e6', '12.345', 'abc']) {
      const result = await run(
        ['wallet:adjust', '--user', 'u1', '--amount', amount, '--key', 'k1', ...WHO],
        services,
      );
      expect(result.code).toBe(2);
    }
    expect(adjust).not.toHaveBeenCalled();
  });

  it('below the threshold nothing is asked', async () => {
    const adjust = jest.fn().mockResolvedValue(NOOP_CHANGE);
    const services = new Map<unknown, unknown>([[WalletAdminService, { adjust }]]);
    const small = await run(
      ['wallet:adjust', '--user', 'u1', '--amount', '1000000', '--key', 'k1', ...WHO],
      services,
    );
    expect(small.asked).toHaveLength(0);
    expect(adjust).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ confirmAmountTiyin: expect.anything() as unknown }),
    );
  });

  it('a service refusal prints its code and the field, exit 1', async () => {
    const adjust = jest
      .fn()
      .mockRejectedValue(new AppError('VALIDATION_ERROR', { field: 'reason' }));
    const services = new Map<unknown, unknown>([[WalletAdminService, { adjust }]]);
    const result = await run(
      ['wallet:adjust', '--user', 'u1', '--amount', '5', '--key', 'k1', ...WHO],
      services,
    );
    expect(result.code).toBe(1);
    expect(result.err).toEqual(['refused: VALIDATION_ERROR {"field":"reason"}']);
  });

  it('terminalSafe escapes control, bidi and zero-width characters and newlines; terminalLines splits first', () => {
    const rlo = String.fromCodePoint(0x202e);
    const esc = String.fromCodePoint(0x1b);
    const zwsp = String.fromCodePoint(0x200b);
    expect(terminalSafe(`a${rlo}b${esc}[2J${zwsp}\nc\r`)).toBe(
      'a\\u{202E}b\\u{1B}[2J\\u{200B}\\u{A}c\\u{D}',
    );
    expect(terminalLines(`x${rlo}\ny\r`)).toEqual(['x\\u{202E}', 'y\\u{D}']);
  });

  it('review:list --limit must be a whole number 1..100 (n4)', async () => {
    const list = jest.fn().mockResolvedValue([]);
    const services = new Map<unknown, unknown>([[ReviewService, { list }]]);
    for (const limit of ['abc', '0', '101', '1.5', '-1', '']) {
      expect((await run(['review:list', '--limit', limit], services)).code).toBe(2);
    }
    expect(list).not.toHaveBeenCalled();
    for (const limit of ['1', '100']) {
      expect((await run(['review:list', '--limit', limit], services)).code).toBe(0);
    }
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 100 }));
  });
});
