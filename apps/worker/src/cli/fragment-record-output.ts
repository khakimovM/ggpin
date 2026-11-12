import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FixtureSanitizer } from '../adapters/fragment/fixture-sanitizer';
import { headOf, pageExcerpt } from '../adapters/fragment/fragment-page';
import type { LeakCheck } from '../adapters/fragment/leak-check';
import type { Exchange } from './fragment-record-client';
import type { FlowResult, RecordedStep } from './fragment-record-flow';
import {
  OutputRefusal,
  assertLocalPath,
  assertNotInSecrets,
  inside,
  type PathPolicy,
} from './fragment-record-paths';

export { OutputRefusal, gitRootOf } from './fragment-record-paths';

// Where the recordings go (plan S0b, fix rounds): the tool writes into NO repository. Raw
// exchanges go to --out; sanitized copies that pass the independent leak check go to the
// --fixtures staging folder (outside ggpin-secrets, R-3). Both are local, outside every git
// repository (real paths, R-5), new or empty, and apart. The lead copies fixtures by hand.

const TEXT_LIMIT = 2000;

async function assertEmpty(dir: string, option: string): Promise<void> {
  if (existsSync(dir) && (await readdir(dir)).length > 0) {
    throw new OutputRefusal(`${option} folder is not empty`);
  }
}

function assertApartAndLocal(rawDir: string, stagingDir: string, policy: PathPolicy): void {
  if (inside(rawDir, stagingDir) || inside(stagingDir, rawDir)) {
    throw new OutputRefusal('--out and --fixtures must be two separate folders');
  }
  assertLocalPath(rawDir, '--out', policy);
  assertLocalPath(stagingDir, '--fixtures', policy);
  assertNotInSecrets(stagingDir, '--fixtures');
}

/** Both folders checked, created (0o700), then checked again on their real paths (R-5). */
export async function prepareOutputDirs(
  rawDir: string,
  stagingDir: string,
  policy: PathPolicy = { oneDriveRoots: [] },
): Promise<void> {
  assertApartAndLocal(rawDir, stagingDir, policy);
  await assertEmpty(rawDir, '--out');
  await assertEmpty(stagingDir, '--fixtures');
  await mkdir(rawDir, { recursive: true, mode: 0o700 });
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  assertApartAndLocal(rawDir, stagingDir, policy);
}

export function rawFileName(index: number, step: string): string {
  return `${String(index + 1).padStart(2, '0')}-${step}.json`;
}

export function rawRecord(recorded: RecordedStep, at: Date): string {
  const record = { step: recorded.step, recordedAt: at.toISOString(), ...recorded.exchange };
  return `${JSON.stringify(record, null, 2)}\n`;
}

export async function writeRaw(dir: string, name: string, content: string): Promise<void> {
  await writeFile(path.join(dir, name), content, { mode: 0o600, flag: 'wx' });
}

type Body = { kind: 'json' | 'html-excerpt' | 'text'; value: unknown; full: string | null };

/** The body: JSON as is (walked later); HTML and text sanitized WHOLE first, then cut (R-1). */
function body(exchange: Exchange, clean: (text: string) => string): Body {
  const text = exchange.response.body;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object') {
      return { kind: 'json', value: parsed, full: null };
    }
  } catch {
    // not JSON: an HTML page or plain text below
  }
  const cleaned = clean(text);
  const type = exchange.response.headers.find(([k]) => k === 'content-type')?.[1] ?? '';
  if (/html/i.test(type) || /<html|<body|<script/i.test(text)) {
    return { kind: 'html-excerpt', value: pageExcerpt(cleaned), full: cleaned };
  }
  return { kind: 'text', value: headOf(cleaned, TEXT_LIMIT), full: cleaned };
}

export interface StagedFixture {
  readonly value: Record<string, unknown>;
  /** Whole sanitized bodies the excerpt was cut from: they must pass the leak check too. */
  readonly fullBodies: readonly string[];
}

/** The fixture shape: no request cookies, no header values, no full page. */
export function fixtureOf(
  recorded: RecordedStep,
  at: Date,
  clean: (text: string) => string,
): StagedFixture {
  const { request, response, redirects } = recorded.exchange;
  const url = new URL(request.url);
  const parsedBody = body(recorded.exchange, clean);
  const value = {
    step: recorded.step,
    recordedAt: at.toISOString(),
    request: { method: request.method, path: `${url.pathname}${url.search}`, form: request.form },
    response: {
      status: response.status,
      contentType: response.headers.find(([k]) => k === 'content-type')?.[1] ?? null,
      setCookieNames: response.setCookies.map((line) => (line.split('=')[0] ?? '').trim()),
      bodyKind: parsedBody.kind,
      body: parsedBody.value,
    },
    redirects,
  };
  return { value, fullBodies: parsedBody.full === null ? [] : [parsedBody.full] };
}

export function summaryOf(result: FlowResult, at: Date): StagedFixture {
  const value = {
    tool: 'fragment-record',
    format: 3,
    recordedAt: at.toISOString(),
    steps: result.steps.map((s) => ({
      step: s.step,
      status: s.exchange.response.status,
      fixture: `${s.step}.json`,
    })),
    skipped: result.skipped,
    stoppedBy: result.stoppedBy,
    apiHash: { found: result.apiHashLength !== null, length: result.apiHashLength },
    pageMarkers: result.markers,
    cookieNamesSupplied: result.cookieNames,
    setCookieNames: result.setCookieNames,
    payAddresses: result.keepAddresses,
    linkPayloads: result.linkPayloads,
    tonSent: false,
  };
  return { value, fullBodies: [] };
}

export type FixtureOutcome =
  | { readonly written: true; readonly file: string }
  | { readonly written: false; readonly file: string; readonly leaks: string[] };

/** Sanitizes, leak-checks the whole bodies and the exact text, writes only a clean fixture. */
export async function writeFixture(
  dir: string,
  file: string,
  staged: StagedFixture,
  sanitizer: FixtureSanitizer,
  leakCheck: LeakCheck,
): Promise<FixtureOutcome> {
  const text = `${JSON.stringify(sanitizer.sanitizeJson(staged.value), null, 2)}\n`;
  const leaks = new Set<string>(leakCheck(text));
  for (const full of staged.fullBodies) for (const rule of leakCheck(full)) leaks.add(rule);
  if (leaks.size > 0) return { written: false, file, leaks: [...leaks].sort() };
  await writeFile(path.join(dir, file), text, { mode: 0o600, flag: 'wx' });
  return { written: true, file };
}
