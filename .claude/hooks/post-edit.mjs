#!/usr/bin/env node
// PostToolUse(Edit|Write): format the file; validate Prisma schema after edits.
import { execFileSync } from 'node:child_process';
import { readPayload } from './read-stdin.mjs';

const { tool_input: input = {} } = await readPayload();
const file = String(input.file_path ?? '');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const run = (args) => {
  try {
    execFileSync(npx, args, { stdio: 'pipe', shell: process.platform === 'win32' });
    return null;
  } catch (e) {
    return String(e.stderr || e.stdout || e.message);
  }
};

if (/\.(ts|tsx|js|mjs|json|md|css)$/.test(file) && !/node_modules|\.next|dist/.test(file)) {
  run(['--no-install', 'prettier', '--write', file]);
}
if (/schema\.prisma$/.test(file)) {
  const err = run(['--no-install', 'prisma', 'validate', '--schema', file]) ;
  if (err) {
    process.stderr.write(`[prisma] schema is invalid after this edit:\n${err}\n`);
    process.exit(2); // shown to Claude so it fixes the schema
  }
  run(['--no-install', 'prisma', 'format', '--schema', file]);
}
process.exit(0);
