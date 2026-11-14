import { describe, expect, it } from 'vitest';
import type { ProductInput } from '../catalog/input-schema';
import { RECIPIENT_CHECK_RETENTION_SEC } from '../queues';
import {
  RECIPIENT_CHECK_REUSE_MS,
  normalizeRecipientInput,
  normalizeTgUsername,
} from './recipient-check';

const TG: ProductInput = [{ key: 'username', type: 'tgUsername', label: 'fields.tgUsername' }];

describe('normalizeTgUsername', () => {
  it('drops surrounding spaces and one leading @, and lower-cases', () => {
    for (const raw of ['aziz_k', 'Aziz_K', '@aziz_k', '@AZIZ_K', '  @Aziz_K  ', '\taziz_k\n']) {
      expect(normalizeTgUsername(raw)).toBe('aziz_k');
    }
  });

  it('is idempotent: a normalized value stays as it is', () => {
    const once = normalizeTgUsername('@Some_User1');
    expect(once).toBe('some_user1');
    expect(normalizeTgUsername(once ?? '')).toBe(once);
  });

  it('refuses what is not a username after normalizing', () => {
    for (const raw of [
      '',
      '@',
      '@@aziz_k',
      'aziz',
      '1aziz_k',
      '_aziz_k',
      'aziz k',
      '@ aziz_k',
      'aziz-k',
      'a'.repeat(33),
      'azíz_k',
      'aziz_k\u200B',
      't.me/aziz_k',
    ]) {
      expect(normalizeTgUsername(raw)).toBeNull();
    }
    expect(normalizeTgUsername('a'.repeat(32))).toBe('a'.repeat(32));
    expect(normalizeTgUsername('abcde')).toBe('abcde');
  });
});

describe('normalizeRecipientInput', () => {
  it('returns the canonical input for a valid form', () => {
    expect(normalizeRecipientInput(TG, { username: '@Aziz_K' })).toEqual({
      ok: true,
      input: { username: 'aziz_k' },
    });
  });

  it('reports a missing field, an unknown key and a bad value by path and code only', () => {
    expect(normalizeRecipientInput(TG, {})).toEqual({
      ok: false,
      issues: [{ path: 'input.username', code: 'invalid_type' }],
    });
    expect(normalizeRecipientInput(TG, { username: 'aziz_k', zone: '1' })).toEqual({
      ok: false,
      issues: [{ path: 'input.zone', code: 'unrecognized_keys' }],
    });
    const bad = normalizeRecipientInput(TG, { username: 'no spaces allowed' });
    expect(bad).toEqual({
      ok: false,
      issues: [{ path: 'input.username', code: 'invalid_format' }],
    });
    expect(JSON.stringify(bad)).not.toContain('spaces');
  });

  it('never reads an inherited property as a field value', () => {
    const fields: ProductInput = [
      { key: 'constructor', type: 'tgUsername', label: 'fields.tgUsername' },
    ];
    expect(normalizeRecipientInput(fields, {})).toEqual({
      ok: false,
      issues: [{ path: 'input.constructor', code: 'invalid_type' }],
    });
    expect(normalizeRecipientInput(TG, { username: 'aziz_k', constructor: 'x' })).toMatchObject({
      ok: false,
    });
  });
});

describe('answer reuse window', () => {
  it('reuses an answer for one minute and keeps a finished job no longer than that', () => {
    expect(RECIPIENT_CHECK_REUSE_MS).toBe(60_000);
    expect(RECIPIENT_CHECK_RETENTION_SEC * 1000).toBeLessThanOrEqual(RECIPIENT_CHECK_REUSE_MS);
  });
});
