// Entry point of the production web image (apps/web/Dockerfile), run by tini instead of server.js.
//
// The standalone server never evaluates next.config.ts, so the start-up check of the server-only
// API URL that the config does (parseServerEnv) would be lost. It runs here, from the same module:
// src/server-env.ts compiled at image build time into ./boot (one rule, no copy). In the image the
// value is also required: an empty API_INTERNAL_URL would make the server call the public URL.
// A bad value stops the container before it listens; the message names the variable, never values
// of other variables.
import { parseServerEnv } from './boot/server-env.js';

const raw = process.env.API_INTERNAL_URL ?? '';

function refuse(reason) {
  process.stderr.write(`web: API_INTERNAL_URL ${reason}; the server is not started\n`);
  process.exit(1);
}

if (raw.trim() === '') refuse('is required in the production image (e.g. http://api:5000/api/v1)');
try {
  parseServerEnv({ API_INTERNAL_URL: raw });
} catch (error) {
  const issues =
    error !== null && typeof error === 'object' && 'issues' in error && Array.isArray(error.issues)
      ? error.issues.map((issue) => String(issue.message)).join('; ')
      : 'is invalid';
  refuse(`is invalid (${issues})`);
}

await import('./server.js');
