import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALL_SECRET_ENV_NAMES,
  API_ONLY_SECRETS,
  API_PRODUCTION_GENERATED_SECRETS,
  API_PRODUCTION_ISSUED_CREDENTIALS,
  WORKER_ONLY_SECRETS,
  WORKER_PRODUCTION_GENERATED_SECRETS,
  WORKER_PRODUCTION_ISSUED_CREDENTIALS,
} from '../env-secrets';
import { REDACTED, isSensitiveKey, redactSecrets } from './index';

// Guards the "a new secret is redacted automatically" promise: names come from the shared
// lists and from the env templates, so a forgotten key shows up here, not in production logs.
const SECRET_SHAPED = /SECRET|TOKEN|PASSWORD|MNEMONIC|COOKIE|PRIVATE|_KEY|_ENC/;

function templateNames(app: string): string[] {
  const path = fileURLToPath(new URL(`../../../../apps/${app}/.env.example`, import.meta.url));
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => /^\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

describe('secret names from the shared lists', () => {
  it('every list is non-empty and has no duplicates', () => {
    for (const list of [
      WORKER_ONLY_SECRETS,
      API_ONLY_SECRETS,
      API_PRODUCTION_GENERATED_SECRETS,
      API_PRODUCTION_ISSUED_CREDENTIALS,
      WORKER_PRODUCTION_GENERATED_SECRETS,
      WORKER_PRODUCTION_ISSUED_CREDENTIALS,
    ]) {
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it.each(ALL_SECRET_ENV_NAMES)('%s is redacted as a key', (name) => {
    expect(isSensitiveKey(name)).toBe(true);
    expect(redactSecrets({ [name]: 'value-1', keep: 'visible' })).toEqual({
      [name]: REDACTED,
      keep: 'visible',
    });
  });

  it('every production-rule secret is also a known secret name', () => {
    const known = new Set(ALL_SECRET_ENV_NAMES);
    for (const name of [
      ...API_PRODUCTION_GENERATED_SECRETS,
      ...API_PRODUCTION_ISSUED_CREDENTIALS,
      ...WORKER_PRODUCTION_GENERATED_SECRETS,
      ...WORKER_PRODUCTION_ISSUED_CREDENTIALS,
    ]) {
      expect(known.has(name)).toBe(true);
    }
  });
});

describe.each(['api', 'worker'])('secret-shaped keys in apps/%s/.env.example', (app) => {
  const secretNames = templateNames(app).filter((name) => SECRET_SHAPED.test(name));

  it('finds the template and some secrets in it', () => {
    expect(secretNames.length).toBeGreaterThan(0);
  });

  it.each(secretNames)('%s is redacted', (name) => {
    expect(isSensitiveKey(name)).toBe(true);
  });
});
