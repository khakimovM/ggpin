import { generateRequestId } from '../request-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function withHeader(value: string | string[] | undefined): string {
  return generateRequestId({ headers: { 'x-request-id': value } });
}

describe('generateRequestId', () => {
  it.each(['abcd1234', 'a'.repeat(64), '3f2b8c1e-9d4a-4b7e-8c2d-1a2b3c4d5e6f', 'REQ-2026-10-31'])(
    'reuses the well-formed incoming id %s',
    (id) => {
      expect(withHeader(id)).toBe(id);
    },
  );

  it.each([
    ['too short', 'abc'],
    ['too long', 'a'.repeat(65)],
    ['space', 'abcd 1234'],
    ['newline (log injection)', 'abcd1234\nfake'],
    ['quote', 'abcd"1234'],
    ['slash', 'abcd/1234'],
    ['unicode', 'abcdéfgh1234'],
    ['empty', ''],
  ])('replaces a malformed id (%s) with a UUID', (_name, id) => {
    const result = withHeader(id);
    expect(result).not.toBe(id);
    expect(result).toMatch(UUID);
  });

  it('generates a UUID when the header is absent or repeated', () => {
    expect(withHeader(undefined)).toMatch(UUID);
    expect(withHeader(['abcd1234', 'efgh5678'])).toMatch(UUID);
  });

  it('never returns the same generated id twice', () => {
    expect(withHeader(undefined)).not.toBe(withHeader(undefined));
  });
});
