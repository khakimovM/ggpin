/**
 * S0 spike only (branch spike/p4-mtcute, never merged): where the test-DC api_id/api_hash file is.
 * Env is read only under src/config (lint rule), so the spike asks here for the path.
 */
export function spikeCredentialsPath(): string {
  const path = process.env.MTCUTE_TEST_CREDENTIALS;
  if (!path) throw new Error('MTCUTE_TEST_CREDENTIALS is not set');
  return path;
}
