import fs, { promises as fsp } from 'node:fs';

// Spies on every file-system call the path checks and the recorder could make before a refusal
// (fix round 3, audit L-1/L-4). Each spy is asserted on its own, by name (review: one summed count
// would hide a spy that never fires, and a failure would not say which call happened).

export interface FsSpies {
  /** Every spy, each named in the assertion, saw no call. */
  readonly expectNone: () => void;
  /** Every spy, each named in the assertion, saw at least one call (the spies are live). */
  readonly expectEach: () => void;
}

export function fsSpies(): FsSpies {
  const spies = {
    existsSync: jest.spyOn(fs, 'existsSync'),
    'realpathSync.native': jest.spyOn(fs.realpathSync, 'native'),
    readFile: jest.spyOn(fsp, 'readFile'),
    readdir: jest.spyOn(fsp, 'readdir'),
    mkdir: jest.spyOn(fsp, 'mkdir'),
  };
  const counts = (): [string, number][] =>
    Object.entries(spies).map(([name, spy]) => [name, spy.mock.calls.length]);
  return {
    expectNone: () => {
      for (const [spy, calls] of counts()) expect({ spy, calls }).toEqual({ spy, calls: 0 });
    },
    expectEach: () => {
      for (const [spy, calls] of counts()) {
        expect({ spy, called: calls > 0 }).toEqual({ spy, called: true });
      }
    },
  };
}
