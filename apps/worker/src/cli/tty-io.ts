import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import type { LoginIo } from './login-flow';

export interface TtyIo extends LoginIo {
  close(): void;
}

/**
 * Prompts on a terminal with `node:readline`. Everything is written to `output` (stderr), so
 * stdout carries only the encrypted blob. While a hidden answer is typed nothing is echoed: the
 * readline output goes through a gate that drops the keystrokes. No history is kept.
 */
export function createTtyIo(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): TtyIo {
  let muted = false;
  const gate = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      if (!muted) output.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input, output: gate, terminal: true, historySize: 0 });
  const question = (prompt: string, hidden: boolean): Promise<string> =>
    new Promise((resolve) => {
      output.write(prompt);
      muted = hidden;
      rl.question('', (answer) => {
        if (hidden) output.write('\n');
        muted = false;
        resolve(answer);
      });
    });
  return {
    ask: (prompt) => question(prompt, false),
    askHidden: (prompt) => question(prompt, true),
    say: (line) => {
      output.write(`${line}\n`);
    },
    close: () => rl.close(),
  };
}
