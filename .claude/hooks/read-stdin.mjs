// Shared helper: read the hook JSON payload from stdin.
export async function readPayload() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

// Exit code 2 blocks the tool call; stderr is shown to Claude as the reason.
export function block(reason) {
  process.stderr.write(`[guard] ${reason}\n`);
  process.exit(2);
}
