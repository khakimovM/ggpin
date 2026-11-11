import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) =>
  readFileSync(resolve(__dirname, path), 'utf8').replace(/\r\n/g, '\n');

describe('design tokens', () => {
  // The handoff file is the source of truth; any drift means a colour was invented or lost.
  it('packages/ui/tokens.css is a 1:1 copy of design/handoff/ggpin-tokens.css', () => {
    expect(read('../tokens.css')).toBe(read('../../../design/handoff/ggpin-tokens.css'));
  });
});
