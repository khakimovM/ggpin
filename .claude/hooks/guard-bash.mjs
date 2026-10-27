#!/usr/bin/env node
// PreToolUse(Bash): blocks destructive, secret-leaking and real-money commands.
import { readPayload, block } from './read-stdin.mjs';

const { tool_input: input = {} } = await readPayload();
const cmd = String(input.command ?? '');

const DESTRUCTIVE = [
  [/prisma\s+migrate\s+reset/i, 'prisma migrate reset'],
  [/prisma\s+db\s+push.*--(force|accept-data-loss)/i, 'prisma db push with data loss'],
  [/\b(drop|truncate)\s+(database|schema|table)\b/i, 'DROP/TRUNCATE'],
  [/rm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\.\/?$|\.\/(apps|packages|docs|design|\.claude)\b)/i, 'rm -rf on project roots'],
  [/git\s+push\b.*(--force(?!-with-lease)|\s-f\b)/i, 'git push --force'],
  [/git\s+reset\s+--hard/i, 'git reset --hard'],
  [/git\s+clean\s+-[a-z]*f/i, 'git clean -f'],
];

const SECRET_LEAK = [
  [/\b(cat|type|more|less|head|tail|bat|Get-Content)\b[^|;&]*\.env(?!\.example)\b/i, 'printing a .env file'],
  [/\b(printenv|env)\b\s*($|\|)/i, 'dumping the whole environment'],
  [/\$\{?(TON_MNEMONIC|WALLET_ENC_KEY|FRAGMENT_COOKIES|SUPPLIER_[A-Z_]*KEY|PAYME_KEY|CLICK_SECRET_KEY|UZUM_[A-Z_]*SECRET|RAHMAT_[A-Z_]*SECRET|TELEGRAM_BOT_TOKEN|JWT_[A-Z_]*SECRET)\b/i, 'echoing a secret variable'],
];

const REAL_MONEY = [
  [/FULFILLMENT_DRY_RUN\s*=\s*(false|0)/i, 'disabling fulfillment dry-run'],
  [/\bTON_NETWORK\s*=\s*mainnet\b/i, 'switching TON to mainnet'],
  [/\b(fragment\.com\/api|toncenter\.com\/api\/v2\/sendBoc|tonapi\.io\/v2\/blockchain\/message)\b/i, 'calling Fragment/TON send endpoints directly'],
  [/\b(checkout\.paycom\.uz|my\.click\.uz\/services\/pay)\b/i, 'calling a production payment endpoint'],
];

for (const [re, label] of [...DESTRUCTIVE, ...SECRET_LEAK, ...REAL_MONEY]) {
  if (re.test(cmd)) {
    block(
      `Blocked: ${label}.\nCommand: ${cmd}\n` +
        'This needs the owner. Explain why it is needed and ask them to run it manually.',
    );
  }
}
process.exit(0);
