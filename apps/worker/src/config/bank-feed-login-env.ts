import { z } from 'zod';
import { workerBankFeedShape } from './bank-feed-env';
import { EnvValidationError } from './env';
import { bankFeedKeySource, forgetBankFeedKey, type SecretFileReader } from './secret-file';

const LoginEnvSchema = z.object({
  BANK_FEED_API_ID: workerBankFeedShape.BANK_FEED_API_ID.unwrap(),
  BANK_FEED_API_HASH: workerBankFeedShape.BANK_FEED_API_HASH.unwrap(),
});

export type LoginEnv = Readonly<z.infer<typeof LoginEnvSchema> & { BANK_FEED_ENC_KEY: string }>;

/**
 * What the login CLI needs (and nothing else: it runs before the session exists, so the worker's
 * full config would refuse to load in live mode). The key comes the worker's way (D-52 D3):
 * BANK_FEED_ENC_KEY_FILE, or inline BANK_FEED_ENC_KEY outside production; both leave
 * `source` once read. Messages name variables, never values.
 */
export function loadLoginEnv(
  source: NodeJS.ProcessEnv = process.env,
  readSecret?: SecretFileReader,
): LoginEnv {
  const clean = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  const parsed = LoginEnvSchema.safeParse(clean);
  const key = bankFeedKeySource(clean, clean.NODE_ENV === 'production', readSecret);
  forgetBankFeedKey(source);
  const problems = [...key.problems];
  if (key.key === undefined && problems.length === 0) {
    problems.push(
      'BANK_FEED_ENC_KEY_FILE (or BANK_FEED_ENC_KEY outside production): is required but not set',
    );
  }
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const name = issue.path.map(String).join('.');
      problems.push(
        `${name}: ${clean[name] === undefined ? 'is required but not set' : issue.message}`,
      );
    }
  }
  if (!parsed.success || key.key === undefined || problems.length > 0) {
    throw new EnvValidationError(problems);
  }
  return Object.freeze({ ...parsed.data, BANK_FEED_ENC_KEY: key.key });
}
