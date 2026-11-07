import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';

/** The terminal of one CLI run; tests inject their own (no TTY, scripted answers). */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** Asks one question and returns the typed line (the amount re-typed above the threshold). */
  prompt(question: string): Promise<string>;
  /** Like `prompt`, but what is typed is not echoed (a card number, the owner's code). */
  secret(question: string): Promise<string>;
}

// Swallows readline's echo of the typed characters.
const muted = (): Writable =>
  new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });

export function processIo(): CliIo {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    async prompt(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    async secret(question) {
      process.stdout.write(question);
      const rl = createInterface({ input: process.stdin, output: muted(), terminal: true });
      try {
        return await rl.question('');
      } finally {
        rl.close();
        process.stdout.write('\n');
      }
    },
  };
}

// Control (Cc), format (Cf: zero-width, bidi overrides) and line/paragraph separators: none is
// visible, and a bidi override can make a bank text read differently from what it says. Each is
// shown as \u{XXXX}, a newline too: one value is always one line (I1, n1).
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Database text made safe for a terminal: no escape sequences, no invisible reordering. */
export function terminalSafe(text: string): string {
  return text.replace(
    HIDDEN,
    (char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`,
  );
}

/** A multi-line database text (a bank message), one safe line per line. */
export function terminalLines(text: string): string[] {
  return text.split('\n').map(terminalSafe);
}
