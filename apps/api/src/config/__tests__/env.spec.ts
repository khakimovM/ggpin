import { loadEnv } from '../env';

describe('loadEnv', () => {
  it('applies defaults when nothing is set', () => {
    expect(loadEnv({})).toEqual({ NODE_ENV: 'development', API_PORT: 5000 });
  });

  it('parses API_PORT from a string', () => {
    expect(loadEnv({ API_PORT: '5050' }).API_PORT).toBe(5050);
  });

  it('refuses to start with an invalid port and names the variable', () => {
    expect(() => loadEnv({ API_PORT: 'abc' })).toThrow(/API_PORT/);
    expect(() => loadEnv({ API_PORT: '70000' })).toThrow(/API_PORT/);
  });

  it('refuses an unknown NODE_ENV', () => {
    expect(() => loadEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});
