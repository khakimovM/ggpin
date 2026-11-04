import { describe, expect, it } from 'vitest';
import { inactiveProductsNote, shouldActivateProducts } from '../prisma/seed/activation.js';

describe('shouldActivateProducts', () => {
  it.each(['development', 'test'])('activates demo products for NODE_ENV=%s', (nodeEnv) => {
    expect(shouldActivateProducts(nodeEnv)).toBe(true);
  });

  // Fail closed: anything but the two explicit values keeps the products inactive.
  it.each([
    ['production', 'production'],
    ['unset', undefined],
    ['empty', ''],
    ['a typo', 'prod'],
    ['staging', 'staging'],
    ['another case', 'Development'],
    ['padded', ' development'],
  ])('keeps products inactive for %s', (_label, nodeEnv) => {
    expect(shouldActivateProducts(nodeEnv)).toBe(false);
  });
});

describe('inactiveProductsNote', () => {
  it('is empty when products are active', () => {
    expect(inactiveProductsNote(true)).toBe('');
  });

  it('says products are inactive and how to get active demo products', () => {
    const note = inactiveProductsNote(false);
    expect(note).toContain('products inactive');
    expect(note).toContain('NODE_ENV=development');
  });
});
