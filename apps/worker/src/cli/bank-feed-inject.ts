import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BankFeedNotifier } from '../bank-feed/bank-feed-notifier';
import type { BankFeedMessage } from '../bank-feed/client/bank-feed-client';
import { AutoCreditPauser } from '../bank-feed/client/auto-credit-pauser';
import { BankChatAnomalyGuard } from '../bank-feed/client/bank-chat-anomaly';
import { IngestService } from '../bank-feed/client/ingest.service';
import { BankFeedAccountRepository } from '../bank-feed/client/bank-feed-account.repository';
import { ListenerRepository } from '../bank-feed/client/listener.repository';
import { SecurityPauseRepository } from '../bank-feed/client/security-pause.repository';
import { TopupCardsRepository } from '../bank-feed/topup-cards.repository';
import { WorkerConfigModule } from '../config/config.module';
import { EnvValidationError, loadProcessEnv, type Env } from '../config/env';
import { PrismaModule } from '../infra/prisma/prisma.module';
import { QueueModule } from '../infra/queue/queue.module';
import { RedisModule } from '../infra/redis/redis.module';
import { InjectUsageError, balanceAfter, parseInjectArgs } from './inject-args';
import { injectDatabaseRefusal, injectPrecheck } from '../config/inject-guard';
import { syntheticBankText } from './inject-text';

// Dev/e2e only (plan S7): one SYNTHETIC bank notification straight into the ordinary ingest path,
// as if the listener had read it from the bot chat (filter, parse, store + cursor, `bank-message`
// job). Refused unless BANK_FEED_MODE=fake (and loadEnv already refuses fake in production), no
// live bank-feed setting or session option (URL `options`, PGOPTIONS) is present, and - checked
// after connecting, on what Postgres reports - the database is the URL's own *_test one or itself
// carries the dev marker ggpin.env = dev in pg_db_role_setting (D-52 r2, r3 L-1).
// It is not shipped in the production image (Dockerfile, devops).
// Usage: npm run bank-feed:inject -w worker -- --source uzcard --amount 50017 --last4 1111

@Module({})
class InjectModule {
  static register(env: Env): DynamicModule {
    return {
      module: InjectModule,
      imports: [WorkerConfigModule.forRoot(env), PrismaModule, RedisModule, QueueModule],
      providers: [
        IngestService,
        BankFeedNotifier,
        ListenerRepository,
        BankChatAnomalyGuard,
        AutoCreditPauser,
        SecurityPauseRepository,
        BankFeedAccountRepository,
        TopupCardsRepository,
      ],
    };
  }
}

async function main(argv: readonly string[]): Promise<number> {
  // Before loadProcessEnv: it drops the key variables from the environment once read.
  const precheck = injectPrecheck();
  if (precheck.refusal !== null) {
    process.stderr.write(`bank-feed-inject: refused, ${precheck.refusal}\n`);
    return 2;
  }
  const env = loadProcessEnv();
  if (env.BANK_FEED_MODE !== 'fake') {
    process.stderr.write('bank-feed-inject: refused, BANK_FEED_MODE is not fake\n');
    return 2;
  }
  const args = parseInjectArgs(argv);
  const app = await NestFactory.createApplicationContext(InjectModule.register(env), {
    logger: ['error', 'warn'],
  });
  try {
    const ingest = app.get(IngestService);
    const repo = app.get(ListenerRepository);
    const refusal = injectDatabaseRefusal(await repo.databaseIdentity(), precheck.urlDatabase);
    if (refusal !== null) {
      process.stderr.write(`bank-feed-inject: refused, ${refusal}\n`);
      return 2;
    }
    const bot = ingest.pinnedBot(args.source);
    if (bot === null) {
      process.stderr.write(`bank-feed-inject: no pinned bot id for ${args.source}\n`);
      return 2;
    }
    const at = new Date();
    const text = syntheticBankText({
      ...args,
      balanceAfterTiyin: balanceAfter(args, await repo.lastBalance(args.source, args.last4)),
      at,
    });
    const message: BankFeedMessage = {
      id: ((await repo.cursor(args.source)) ?? 0n) + 1n,
      date: at,
      chatId: bot,
      senderId: bot,
      senderIsBot: true,
      text,
      outgoing: false,
      forwarded: false,
      editDate: null,
      viaBotId: null,
    };
    const result = await ingest.ingest(args.source, message, at);
    process.stdout.write(
      result.stored
        ? `stored bankMessageId=${result.bankMessageId}\n`
        : `not stored: ${result.reason}\n`,
    );
    return result.stored ? 0 : 1;
  } finally {
    await app.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    const known = error instanceof EnvValidationError || error instanceof InjectUsageError;
    const text = known ? error.message : error instanceof Error ? error.name : 'unknown error';
    process.stderr.write(`bank-feed-inject: ${text}\n`);
    process.exit(2);
  },
);
