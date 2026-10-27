#!/usr/bin/env node
// PreToolUse(Read|Edit|Write|MultiEdit): protects secret files and blocks writing secrets into code.
import { readPayload, block } from './read-stdin.mjs';

const { tool_name: tool, tool_input: input = {} } = await readPayload();
const path = String(input.file_path ?? input.path ?? '').replace(/\\/g, '/');

const SECRET_FILE = /(^|\/)(\.env(\.(local|production|staging|development|test))?|\.env\..*\.local|.*\.(pem|key|p12|pfx)|secrets\/.*|wallet[^/]*\.json|fragment-session[^/]*\.json)$/i;
if (path && SECRET_FILE.test(path) && !/\.env\.example$/i.test(path)) {
  block(`Access to secret file "${path}" is not allowed for ${tool}. Use .env.example for placeholders.`);
}

if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') {
  const text = [input.content, input.new_string, ...(input.edits ?? []).map((e) => e.new_string)]
    .filter(Boolean)
    .join('\n');
  const PATTERNS = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
    [/\b(?:[a-z]{3,8}\s+){23}[a-z]{3,8}\b/, 'what looks like a 24-word mnemonic'],
    [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, 'a Telegram bot token'],
    [/stel_(ssid|token|ton_token)\s*[:=]\s*["'][A-Za-z0-9%._-]{16,}/, 'Fragment session cookies'],
    [/\b(sk|pk)_(live|prod)_[A-Za-z0-9]{16,}/, 'a live API key'],
  ];
  // Prose (markdown) can contain long runs of short words; only check code/config for mnemonics.
  const skipMnemonic = /__fixtures__\//.test(path) || /\.(md|mdx|txt)$/i.test(path);
  for (const [re, label] of PATTERNS) {
    if (re.test(text) && !(skipMnemonic && label === 'what looks like a 24-word mnemonic')) {
      block(`Refusing to write ${label} into "${path}". Secrets belong in env / secret store only.`);
    }
  }
}
process.exit(0);
