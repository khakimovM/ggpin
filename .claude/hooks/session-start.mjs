#!/usr/bin/env node
// SessionStart: remind Claude of the current roadmap phase and the money/safety defaults.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
let phase = 'unknown (docs/11-ROADMAP.md not found)';
try {
  const md = readFileSync(join(root, 'docs', '11-ROADMAP.md'), 'utf8');
  const sections = md.split(/\n(?=## )/);
  const open = sections.find((s) => /^## /.test(s) && /- \[ \]/.test(s));
  if (open) phase = open.split('\n')[0].replace(/^## /, '');
  else phase = 'all phases ticked';
} catch {}
console.log(
  [
    `Current roadmap phase: ${phase}`,
    'Defaults: FULFILLMENT_DRY_RUN=true, payment providers in sandbox, TON testnet only if configured.',
    'Reports to the owner in Uzbek. Run code-reviewer (+ security-auditor for money/auth) before closing a phase.',
  ].join('\n'),
);
