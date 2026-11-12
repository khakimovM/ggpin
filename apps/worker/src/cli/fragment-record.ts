import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fragmentRecordMain } from './fragment-record-main';

// Owner-only tool (plan S0b, docs/suppliers/fragment.md): records Fragment's money-free responses
// (Stars page, recipient search, purchase request, payment link description, logged-out page)
// with the owner's browser cookies. It never signs or sends anything, imports no TON library,
// refuses NODE_ENV=production and writes into no repository: raw responses go to --out, sanitized
// copies to the --fixtures staging folder (defaults: ~/Desktop/ggpin-secrets/fragment-raw/<time>
// and, outside ggpin-secrets, ~/Desktop/ggpin-fixtures-staging/<time>; F-10).
// Usage, from the repository root and without npm (F-1: npm echoes the command line and logs it):
//   node apps/worker/dist/cli/fragment-record.js --cookies <file> --username <name>
//     --telegram-id <digits> [--confirm-no-payment --wallet <address> --name <name> --phone <n>]

fragmentRecordMain(process.argv.slice(2), {
  fetch: (input, init) => fetch(input, init),
  sleep: async (ms) => {
    await delay(ms);
  },
  now: () => new Date(),
  home: os.homedir(),
  cwd: process.cwd(),
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
}).then(
  (code) => process.exit(code),
  () => {
    process.stderr.write('fragment-record: unexpected error\n');
    process.exit(2);
  },
);
