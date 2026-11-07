import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { scrubSecretsInText } from '@repo/shared';
import { cliSessionEnv } from '../config/cli-session-env';
import { EnvValidationError, loadProcessEnv } from '../config/env';
import { processIo, type CliIo } from './cli-io';
import { sessionOf } from './cli-session';
import { OpsCliModule } from './ops-cli.module';
import { findCommand, helpText, runCommand } from './ops-cli.runner';

/**
 * Entry of the owner CLI (`node --env-file-if-exists=.env dist/cli/ops-cli.js <command> ...`,
 * D-37 (9); docs/05 §7 for why not plain `npm run`): an application context, no
 * HTTP server. The environment is the API's own (validated the same way as at API boot); the
 * process exits with the command's code after closing Prisma, Redis and the queues.
 */
async function main(argv: readonly string[]): Promise<number> {
  const io = processIo();
  const [name, ...rest] = argv;
  if (name === undefined || name === 'help' || name === '--help') {
    const command = findCommand(rest[0]);
    for (const line of command === undefined ? helpText() : [command.usage]) io.out(line);
    return 0;
  }
  const command = findCommand(name);
  if (command === undefined) {
    io.err(`unknown command: ${name}`);
    for (const line of helpText()) io.err(line);
    return 2;
  }
  let env;
  try {
    env = loadProcessEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
  const app = await NestFactory.createApplicationContext(OpsCliModule.register(env), {
    logger: ['error', 'warn'],
  });
  const code = await runCommand(command, rest, app, io, sessionOf(cliSessionEnv())).finally(() =>
    close(app, io),
  );
  return code;
}

// The command's result is already decided (and committed); a failing shutdown is reported but
// never turns a done command into a failure, or a refusal into success (n5).
async function close(app: { close(): Promise<void> }, io: CliIo): Promise<void> {
  try {
    await app.close();
  } catch (error) {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : 'non-Error thrown';
    io.err(`warning: shutdown failed: ${scrubSecretsInText(text)}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const text = error instanceof Error ? (error.stack ?? error.name) : 'non-Error thrown';
    process.stderr.write(`ops failed: ${scrubSecretsInText(text)}\n`);
    process.exitCode = 1;
  },
);
