import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { ACTOR, useOpsE2e } from '../../../../cli/__tests__/ops-e2e.harness';
import { APP_CONFIG, type AppConfig } from '../../../../config/config.module';
import { RedisService } from '../../../../infra/redis/redis.service';
import { TgOutboxEnqueuer } from '../../../../modules/notifications/tg-outbox.enqueuer';
import { adjustOtpTarget } from '../../../../modules/wallet/wallet-admin.input';
import { WalletAdminService } from '../../../../modules/wallet/wallet-admin.service';
import { AppError } from '../../../exceptions/app-error';
import { ownerOtpKey, type OtpAnswer } from '../owner-otp';
import { OwnerOtpIssuer } from '../owner-otp.issuer';
import { ownerCode, sentMessageFor } from './owner-otp.testing';

const t = useOpsE2e();
const BIG = 100_000_001n; // just above the 1 000 000 so'm threshold of the test env

async function reason(promise: Promise<unknown>): Promise<unknown> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error(`expected an AppError, got ${String(error)}`);
  return error.details?.['reason'] ?? error.details?.['field'];
}

/** One wallet:adjust above the threshold with its own key; `otp` decides. */
async function adjustWith(userId: string, otp: OtpAnswer | undefined, key = randomUUID()) {
  return t
    .app()
    .get(WalletAdminService)
    .adjust({
      userId,
      amountTiyin: BIG,
      reason: 'owner code e2e',
      ...ACTOR,
      auditId: key,
      confirmAmountTiyin: BIG,
      ...(otp === undefined ? {} : { otp }),
    });
}

const scopeFor = (userId: string, key: string) => ({
  action: 'wallet:adjust' as const,
  amountTiyin: BIG,
  target: adjustOtpTarget(userId, key),
});

const otherCode = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

describe('owner one-time code (D-46, real Redis DB 15)', () => {
  it('refused without a code, with a wrong one, or one made for another action, amount or target; nothing written', async () => {
    const userId = await t.user();
    const key = randomUUID();
    const app = t.app();
    expect(await reason(adjustWith(userId, undefined, key))).toBe('OTP_REQUIRED');

    const right = await ownerCode(app, scopeFor(userId, key));
    expect(await reason(adjustWith(userId, { ...right, code: otherCode(right.code) }, key))).toBe(
      'OTP_INVALID',
    );
    const others = [
      { ...scopeFor(userId, key), action: 'payment:reverse' as const },
      { ...scopeFor(userId, key), amountTiyin: BIG + 100n },
      scopeFor(await t.user(), key),
      scopeFor(userId, randomUUID()),
    ];
    const used: OtpAnswer[] = [];
    const warned: string[] = [];
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation((...args: unknown[]) => {
      warned.push(args.map(String).join(' '));
    });
    try {
      for (const scope of others) {
        const otp = await ownerCode(app, scope);
        used.push(otp);
        expect(await reason(adjustWith(userId, otp, key))).toBe('OTP_MISMATCH');
      }
    } finally {
      warn.mockRestore();
    }
    // Each mismatch is a security warn (R2-I2): the action and the result, nothing else.
    const security = warned.filter((line) => line.includes('owner code refused'));
    expect(security).toEqual(
      others.map(() => 'security: owner code refused action=wallet:adjust result=OTP_MISMATCH'),
    );
    for (const line of warned) {
      for (const otp of used) {
        expect(line).not.toContain(otp.code);
        expect(line).not.toContain(otp.challengeId);
      }
      for (const scope of others) expect(line).not.toContain(scope.target);
    }
    expect(await t.db().ledgerEntry.count({ where: { userId } })).toBe(0);
    expect(await t.db().auditLog.count({ where: { id: key } })).toBe(0);
  });

  it('works once: a second use, or a code past its time, is refused', async () => {
    const userId = await t.user();
    const key = randomUUID();
    const otp = await ownerCode(t.app(), scopeFor(userId, key));
    const done = await adjustWith(userId, otp, key);
    expect(done.applied).toBe(true);
    expect((await t.audit(done.auditId)).after).toMatchObject({ otpVerified: true });
    // Same key, same request: the replay would write nothing, but the used code is gone first.
    expect(await reason(adjustWith(userId, otp, key))).toBe('OTP_EXPIRED');

    const late = randomUUID();
    const expired = await ownerCode(t.app(), scopeFor(userId, late));
    await t.app().get(RedisService).client.pexpire(ownerOtpKey(expired.challengeId), 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await reason(adjustWith(userId, expired, late))).toBe('OTP_EXPIRED');
    expect(await t.db().ledgerEntry.count({ where: { userId } })).toBe(1);
  });

  it('after 5 wrong tries even the right code is refused (OTP_LOCKED); each refusal is a security warn without the code (R1-I4)', async () => {
    const userId = await t.user();
    const key = randomUUID();
    const otp = await ownerCode(t.app(), scopeFor(userId, key));
    const warned: string[] = [];
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation((...args: unknown[]) => {
      warned.push(args.map(String).join(' '));
    });
    try {
      for (let i = 0; i < 5; i += 1) {
        expect(await reason(adjustWith(userId, { ...otp, code: otherCode(otp.code) }, key))).toBe(
          'OTP_INVALID',
        );
      }
      expect(await reason(adjustWith(userId, otp, key))).toBe('OTP_LOCKED');
    } finally {
      warn.mockRestore();
    }
    const security = warned.filter((line) => line.includes('owner code refused'));
    expect(security).toHaveLength(6);
    expect(
      security.filter((l) => l.includes('action=wallet:adjust result=OTP_INVALID')),
    ).toHaveLength(5);
    expect(security[5]).toContain('action=wallet:adjust result=OTP_LOCKED');
    for (const line of warned) {
      for (const secret of [
        otp.code,
        otherCode(otp.code),
        otp.challengeId,
        adjustOtpTarget(userId, key),
      ]) {
        expect(line).not.toContain(secret);
      }
    }
    expect(await t.db().ledgerEntry.count({ where: { userId } })).toBe(0);
  });

  it('Redis holds the HMAC hash, the binding and the attempts for at most 3 minutes; never the code', async () => {
    const userId = await t.user();
    const otp = await ownerCode(t.app(), scopeFor(userId, randomUUID()));
    const redis = t.app().get(RedisService).client;
    const key = ownerOtpKey(otp.challengeId);
    const stored = await redis.hgetall(key);
    expect(Object.keys(stored).sort()).toEqual(['attempts', 'binding', 'hash']);
    expect(JSON.stringify(stored)).not.toContain(otp.code);
    expect(JSON.stringify(stored)).not.toContain(otp.challengeId);
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(180);
    await redis.del(key);
  });

  it('without OWNER_ALERT_CHAT_ID no code is issued (OTP_UNAVAILABLE) and nothing is stored', async () => {
    const app = t.app();
    const config = { ...app.get<AppConfig>(APP_CONFIG) };
    delete (config as { OWNER_ALERT_CHAT_ID?: string }).OWNER_ALERT_CHAT_ID;
    const issuer = new OwnerOtpIssuer(app.get(RedisService), app.get(TgOutboxEnqueuer), config);
    const target = adjustOtpTarget(await t.user(), randomUUID());
    expect(await reason(issuer.issue({ action: 'wallet:adjust', amountTiyin: BIG, target }))).toBe(
      'OTP_UNAVAILABLE',
    );
    await expect(sentMessageFor(app, target)).rejects.toThrow('no owner code message');
  });

  it('the CLI flow: the code is in no log line and no output, and its message is removed when the command ends', async () => {
    const userId = await t.user();
    const key = randomUUID().replaceAll('-', '');
    const target = adjustOtpTarget(userId, key);
    let code = '';
    const seen: string[] = [];
    const record = (...args: unknown[]) => {
      seen.push(args.map(String).join(' '));
    };
    const spies = [
      jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => (record(chunk), true)),
      jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => (record(chunk), true)),
      ...(['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(record),
      ),
    ];
    let run;
    try {
      run = await t.run(
        ['wallet:adjust', '--user', userId, '--amount', '1000000.01', '--key', key].concat([
          '--reason',
          'owner code e2e',
          '--operator',
          ACTOR.operator,
        ]),
        [
          '1000000.01',
          async () => {
            const job = await sentMessageFor(t.app(), target);
            code = /: (\d{6})\n/.exec(String((job.data as { text: string }).text))?.[1] ?? '';
            return code;
          },
        ],
      );
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(run.code).toBe(0);
    expect(code).toMatch(/^\d{6}$/);
    for (const line of [...seen, ...run.out, ...run.err]) expect(line).not.toContain(code);
    await expect(sentMessageFor(t.app(), target)).rejects.toThrow('no owner code message');
  });

  it('an ephemeral outbox job leaves nothing in Redis once sent, or once it finally fails', async () => {
    const name = `tg-outbox-e2e-${randomUUID()}`;
    const connection = { url: t.env.REDIS_URL, maxRetriesPerRequest: null };
    const queue = new Queue(name, { connection });
    const outbox = new TgOutboxEnqueuer(queue);
    const worker = new Worker(
      name,
      (job) => {
        if (job.id === 'fails') throw new UnrecoverableError('telegram 400');
        return Promise.resolve();
      },
      { connection },
    );
    try {
      const settled = new Promise<void>((resolve) => {
        let count = 0;
        const done = () => {
          count += 1;
          if (count === 2) resolve();
        };
        worker.on('completed', done);
        worker.on('failed', done);
      });
      await outbox.enqueueEphemeral('sent', { chatId: '700000001', text: 'code: 000000\n' });
      await outbox.enqueueEphemeral('fails', { chatId: '700000001', text: 'code: 000000\n' });
      await settled;
      expect(await queue.getJob('sent')).toBeUndefined();
      expect(await queue.getJob('fails')).toBeUndefined();
      const redis = t.app().get(RedisService).client;
      expect(await redis.keys(`bull:${name}:sent*`)).toEqual([]);
      expect(await redis.keys(`bull:${name}:fails*`)).toEqual([]);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
