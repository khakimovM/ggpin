import type { CliIo } from '../cli-io';

/** A fixed answer, or one computed when asked (the owner's code exists only after issuing). */
export type Answer = string | (() => Promise<string>);

/** A scripted terminal: what was printed, and the answers to give when asked (in order). */
export function scriptedIo(answers: readonly Answer[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const queue = [...answers];
  const answer = (question: string): Promise<string> => {
    asked.push(question);
    const next = queue.shift() ?? '';
    return typeof next === 'string' ? Promise.resolve(next) : next();
  };
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    prompt: answer,
    secret: answer,
  };
  return { io, out, err, asked };
}
