import { z } from 'zod';
import { EnvValidationError } from './env';
import {
  forgetFragmentSessionKey,
  fragmentKeySource,
  type FragmentSessionKey,
} from './fragment-session-env';
import type { SecretFileReader } from './secret-file';

export interface FragmentImportEnv {
  readonly DATABASE_URL: string;
  readonly key: FragmentSessionKey;
}

const DatabaseUrlSchema = z.url({ protocol: /^postgres(ql)?$/ });

/**
 * What `fragment:session-import` needs and nothing else (the full worker config is not needed to
 * store a session): DATABASE_URL and the session key the worker's way (D-52 D3):
 * FRAGMENT_SESSION_ENC_KEY_FILE, or inline FRAGMENT_SESSION_ENC_KEY outside production. The key
 * variables leave `source` once read. Messages name variables, never values.
 */
export function loadFragmentImportEnv(
  source: NodeJS.ProcessEnv = process.env,
  readSecret?: SecretFileReader,
): FragmentImportEnv {
  const clean = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  const production = clean.NODE_ENV === 'production';
  const url = DatabaseUrlSchema.safeParse(clean.DATABASE_URL);
  const key = fragmentKeySource(clean, production, true, readSecret);
  forgetFragmentSessionKey(source);
  const problems = [...key.problems];
  if (!url.success) {
    problems.push(
      `DATABASE_URL: ${clean.DATABASE_URL === undefined ? 'is required but not set' : 'must be a postgres URL'}`,
    );
  }
  if (key.key === undefined && key.problems.length === 0) {
    problems.push(
      'FRAGMENT_SESSION_ENC_KEY_FILE (or FRAGMENT_SESSION_ENC_KEY outside production): is required but not set',
    );
  }
  if (!url.success || key.key === undefined || problems.length > 0) {
    throw new EnvValidationError(problems);
  }
  return Object.freeze({ DATABASE_URL: url.data, key: key.key });
}
