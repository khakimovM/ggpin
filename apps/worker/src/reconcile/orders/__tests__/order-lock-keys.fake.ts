import type { LockKeyReader } from '../order-lock-keys';

// A Redis with only SCAN and GET (the walk's LockKeyReader): any write the walk tried would not
// exist. SCAN pages over the sorted keys, `size` per call, the cursor being the next index.

export class FakeLockRedis implements LockKeyReader {
  /** String keys and their values. */
  readonly values = new Map<string, string>();
  /** Keys SCAN still lists but GET finds gone (they went away in between). */
  readonly scanOnly = new Set<string>();
  /** Keys of another type: GET answers WRONGTYPE. */
  readonly wrongType = new Set<string>();
  readonly scans: string[] = [];

  scan(
    cursor: string,
    _match: 'MATCH',
    pattern: string,
    _count: 'COUNT',
    size: number,
  ): Promise<[string, string[]]> {
    this.scans.push(cursor);
    const prefix = pattern.replace(/\*$/, '');
    const all = [...new Set([...this.values.keys(), ...this.scanOnly, ...this.wrongType])]
      .filter((key) => key.startsWith(prefix))
      .sort();
    const at = Number(cursor);
    const end = at + size;
    return Promise.resolve([end >= all.length ? '0' : String(end), all.slice(at, end)]);
  }

  get(key: string): Promise<string | null> {
    if (this.wrongType.has(key)) {
      return Promise.reject(
        new Error('WRONGTYPE Operation against a key holding the wrong kind of value'),
      );
    }
    if (this.scanOnly.has(key)) return Promise.resolve(null);
    return Promise.resolve(this.values.get(key) ?? null);
  }
}
