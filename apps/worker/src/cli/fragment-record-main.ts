import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createFixtureSanitizer, type SecretValue } from '../adapters/fragment/fixture-sanitizer';
import { createLeakCheck } from '../adapters/fragment/leak-check';
import {
  fragmentRecordEnvRefusal,
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
  // R-2: with the purchase steps, at least one name (--name or a --redact text line).
  if (args.confirmNoPayment && args.names.length === 0 && redact.texts.length === 0) {
    throw new RecordUsageError('--confirm-no-payment needs --name (or a name line in --redact)');
  }
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

/** True when any answer shows a word of any --name, in any encoding the leak check decodes. */
function namesSeen(names: readonly string[], steps: readonly RecordedStep[]): boolean {
  const check = createLeakCheck({
    secrets: names.map((value) => ({ kind: 'name' as const, value })),
    keepAddresses: [],
  });
  return steps.some((s) => check(s.exchange.response.body).includes('name'));
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
  if (args.names.length > 0 && !namesSeen(args.names, result.steps)) {
    say('nothing staged: name not found in responses (check --name)');
    if (result.stoppedBy !== null) say(`stopped early: ${result.stoppedBy}`);
    return 1;
  }
  const sanitizer = createFixtureSanitizer({ secrets, keepAddresses: result.keepAddresses });
  const leakCheck = createLeakCheck({ secrets, keepAddresses: result.keepAddresses });
  let withheld = 0;
  const at = deps.now();
  const outputs = [
    ...result.steps.map((s) => ({
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
    const refusal = fragmentRecordEnvRefusal(deps.env);
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
