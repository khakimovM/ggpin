import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createFixtureSanitizer, type SecretValue } from '../adapters/fragment/fixture-sanitizer';
import { createLeakCheck } from '../adapters/fragment/leak-check';
import { namePresence } from '../adapters/fragment/name-presence';
import {
  fragmentRecordEnvRefusal,
  fragmentRecordExecArgvRefusal,
  fragmentRecordOneDriveRoots,
  fragmentRecordViaNpm,
} from '../config/fragment-record-env';
import {
  RecordUsageError,
  parseFragmentRecordArgs,
  type FragmentRecordArgs,
} from './fragment-record-args';
import type { FetchLike } from './fragment-record-client';
import { runRecordingFlow, type FlowInput, type RecordedStep } from './fragment-record-flow';
import {
  parseCookieFile,
  parseRedactFile,
  parseTonConnectFile,
  type TonConnectInfo,
} from './fragment-record-inputs';
import {
  OutputRefusal,
  fixtureOf,
  prepareOutputDirs,
  rawFileName,
  rawRecord,
  summaryOf,
  writeFixture,
  writeRaw,
} from './fragment-record-output';
import { assertLocalPath, type PathPolicy } from './fragment-record-paths';

// `fragment:record` (plan S0b): the owner runs it on their own machine to record Fragment's
// money-free responses. Console lines carry only step names, HTTP statuses, file and folder names
// and leak-rule names: never cookies, the hash, a response body, a name or an address.

export interface RecordMainDeps {
  readonly fetch: FetchLike;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => Date;
  readonly home: string;
  readonly cwd: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Defaults to the process environment (read in config/ only). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to the process's own Node command-line options (I-4). */
  readonly execArgv?: readonly string[];
}

export const NO_TON_SENT =
  'no TON was sent: this tool has no code that signs or sends a transaction';

/** Reads an input file; refuses one inside a git repository or on a network path (R-10). */
async function readInput(file: string, option: string, policy: PathPolicy): Promise<string> {
  assertLocalPath(file, option, policy);
  try {
    return await readFile(file, 'utf8');
  } catch {
    throw new RecordUsageError(`cannot read the ${option} file`);
  }
}

interface Inputs {
  readonly flow: FlowInput;
  readonly extraSecrets: SecretValue[];
}

async function loadInputs(args: FragmentRecordArgs, policy: PathPolicy): Promise<Inputs> {
  const cookies = parseCookieFile(await readInput(args.cookiesFile, '--cookies', policy));
  const tonConnect: TonConnectInfo | null =
    args.tonConnectFile === null
      ? null
      : parseTonConnectFile(await readInput(args.tonConnectFile, '--ton-connect', policy));
  const redact =
    args.redactFile === null
      ? { texts: [], addresses: [], phones: [] }
      : parseRedactFile(await readInput(args.redactFile, '--redact', policy));
  if (args.confirmNoPayment && args.phones.length === 0 && redact.phones.length === 0) {
    throw new RecordUsageError('--confirm-no-payment needs --phone (or a phone line in --redact)');
  }
  const extraSecrets: SecretValue[] = [
    ...args.names.map((value) => ({ kind: 'name' as const, value })),
    ...redact.texts.map((value) => ({ kind: 'secret' as const, value })),
    ...redact.addresses.map((value) => ({ kind: 'address' as const, value })),
    ...[...args.phones, ...redact.phones].map((value) => ({ kind: 'phone' as const, value })),
  ];
  extraSecrets.push({ kind: 'tg_id', value: args.telegramId });
  if (args.wallet !== null) extraSecrets.push({ kind: 'address', value: args.wallet });
  return {
    flow: {
      cookies,
      username: args.username,
      confirmNoPayment: args.confirmNoPayment,
      recipientAgeCheck: args.recipientAgeCheck,
      tonConnect,
    },
    extraSecrets,
  };
}

const NAME_KINDS = new Set(['name', 'secret']);

/**
 * Why nothing may be staged for the --name values (F-5, M-1), or null: no answer shows any of
 * them, or one is only partly shown (a typo or another transliteration). Never names a value.
 */
function nameProblem(names: readonly string[], steps: readonly RecordedStep[]): string | null {
  if (names.length === 0) return null;
  const presence = namePresence(
    names,
    steps.map((s) => s.exchange.response.body),
  );
  if (presence.every((p) => p.found === 0)) return 'name not found in responses (check --name)';
  const partly = presence.findIndex((p) => p.found > 0 && p.found < p.total);
  return partly === -1 ? null : `name ${partly + 1} partly found (check --name)`;
}

async function record(
  args: FragmentRecordArgs,
  deps: RecordMainDeps,
  policy: PathPolicy,
): Promise<number> {
  const say = (line: string): void => deps.stdout(`fragment-record: ${line}`);
  const inputs = await loadInputs(args, policy);
  await prepareOutputDirs(args.outDir, args.fixturesDir, policy);
  say(`raw folder: ${path.basename(args.outDir)}`);
  say(`staging folder: ${path.basename(args.fixturesDir)}`);
  let index = 0;
  const result = await runRecordingFlow(inputs.flow, {
    fetch: deps.fetch,
    sleep: deps.sleep,
    note: say,
    onExchange: async (recorded) => {
      const file = rawFileName(index, recorded.step);
      index += 1;
      await writeRaw(args.outDir, file, rawRecord(recorded, deps.now()));
      say(`${recorded.step} HTTP ${recorded.exchange.response.status} -> raw ${file}`);
    },
  });
  const secrets = [...result.secrets, ...inputs.extraSecrets];
  // R-2: a name nobody knows cannot be redacted; stage nothing rather than guess.
  if (!secrets.some((s) => NAME_KINDS.has(s.kind))) {
    say('nothing staged: no display name is known (give --name)');
    return 1;
  }
  // F-5: a --name that no answer shows is likely mistyped; the real name would then go unredacted.
  const problem = nameProblem(args.names, result.steps);
  if (problem !== null) {
    say(`nothing staged: ${problem}`);
    if (result.stoppedBy !== null) say(`stopped early: ${result.stoppedBy}`);
    return 1;
  }
  const sanitizer = createFixtureSanitizer({ secrets, keepAddresses: result.keepAddresses });
  const leakCheck = createLeakCheck({ secrets, keepAddresses: result.keepAddresses });
  let withheld = 0;
  const at = deps.now();
  // L-1: with no API hash found, its unknown value cannot be redacted: only the summary is staged.
  const hashKnown = result.apiHashLength !== null;
  if (!hashKnown) {
    for (const s of result.steps) {
      withheld += 1;
      say(`withheld: ${s.step}.json (no api hash)`);
    }
  }
  const outputs = [
    ...(hashKnown ? result.steps : []).map((s) => ({
      file: `${s.step}.json`,
      staged: fixtureOf(s, at, (text) => sanitizer.sanitizeText(text)),
    })),
    { file: 'summary.json', staged: summaryOf(result, at) },
  ];
  for (const { file, staged } of outputs) {
    const outcome = await writeFixture(args.fixturesDir, file, staged, sanitizer, leakCheck);
    if (outcome.written) {
      say(`staged -> ${outcome.file}`);
    } else {
      withheld += 1;
      say(`withheld: ${outcome.file} (leak check: ${outcome.leaks.join(', ')})`);
    }
  }
  if (result.stoppedBy !== null) say(`stopped early: ${result.stoppedBy}`);
  return result.stoppedBy === null && withheld === 0 ? 0 : 1;
}

export async function fragmentRecordMain(
  argv: readonly string[],
  deps: RecordMainDeps,
): Promise<number> {
  try {
    const refusal =
      fragmentRecordEnvRefusal(deps.env) ?? fragmentRecordExecArgvRefusal(deps.execArgv);
    if (refusal !== null) {
      deps.stderr(`fragment-record: refused, ${refusal}`);
      return 2;
    }
    if (fragmentRecordViaNpm(deps.env)) {
      deps.stderr(
        'fragment-record: warning, started through npm: npm may print this command line and keep ' +
          'it in its log; run node apps/worker/dist/cli/fragment-record.js instead',
      );
    }
    const policy: PathPolicy = { oneDriveRoots: fragmentRecordOneDriveRoots(deps.env) };
    const args = parseFragmentRecordArgs(argv, { home: deps.home, cwd: deps.cwd, now: deps.now() });
    return await record(args, deps, policy);
  } catch (error) {
    if (error instanceof RecordUsageError || error instanceof OutputRefusal) {
      deps.stderr(`fragment-record: ${error.message}`);
      return 2;
    }
    deps.stderr(`fragment-record: failed (${error instanceof Error ? error.name : 'unknown'})`);
    return 1;
  } finally {
    deps.stdout(`fragment-record: ${NO_TON_SENT}`);
  }
}
