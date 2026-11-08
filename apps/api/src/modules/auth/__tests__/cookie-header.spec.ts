import { cookieValues } from '../cookie-header';

describe('cookieValues', () => {
  it('returns [] without a header or without the name', () => {
    expect(cookieValues(undefined, 'a')).toEqual([]);
    expect(cookieValues('b=1; c=2', 'a')).toEqual([]);
  });

  it('finds a single value and does not match on a name prefix or suffix', () => {
    expect(cookieValues('xa=0; a=1; ax=2', 'a')).toEqual(['1']);
  });

  it('keeps every occurrence in header order, empty ones included', () => {
    expect(cookieValues('a=first; b=2; a=second; a=', 'a')).toEqual(['first', 'second', '']);
  });

  it('joins a header that arrived as an array', () => {
    expect(cookieValues(['a=1', 'a=2'], 'a')).toEqual(['1', '2']);
  });

  it('decodes percent-escapes, keeps quotes, and survives a malformed escape (like cookie@2)', () => {
    expect(cookieValues('a=x%20y', 'a')).toEqual(['x y']);
    expect(cookieValues('a="x%20y"', 'a')).toEqual(['"x y"']);
    expect(cookieValues('a="q"', 'a')).toEqual(['"q"']);
    expect(cookieValues('a=%E0%A4%A', 'a')).toEqual(['%E0%A4%A']);
  });

  it('trims only SP and HTAB around names and values', () => {
    expect(cookieValues(' \ta \t=\t 1 \t; a=2', 'a')).toEqual(['1', '2']);
  });

  it('a name preceded by \v is a different cookie, exactly as in the library', () => {
    expect(cookieValues('\u000ba=1', 'a')).toEqual([]);
    expect(cookieValues('a=1; \u000ba=2', 'a')).toEqual(['1']);
    expect(cookieValues('a=\u000b1', 'a')).toEqual(['\u000b1']);
  });

  it('keeps "=" inside the value', () => {
    expect(cookieValues('a=b=c', 'a')).toEqual(['b=c']);
  });
});
