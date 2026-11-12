import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// `htmlLimitedBots` (next.config.ts) makes the first byte of every page wait for its metadata, so a
// `generateMetadata` that fetches anything would slow every visitor down. The rule is: metadata
// comes from i18n and static data only. These tests read the sources, like the money-handling test
// of the landing does.

const APP_DIR = join(__dirname, '..', '..', '..', 'app');
const FORBIDDEN_IMPORT =
  /from\s+['"][^'"]*(catalog-server|lib\/api\/|api-client|server-fetch)[^'"]*['"]/;
const FORBIDDEN_CALL = /\bfetch\s*\(|catalogServer|getCatalog|fetchCatalog|apiClient/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The text of `export async function generateMetadata(...) { ... }` up to its closing brace. */
function metadataBody(source: string): string {
  const start = source.search(/export\s+(async\s+)?function\s+generateMetadata\b/);
  if (start === -1) return '';
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end === -1 ? undefined : end + 2);
}

const withMetadata = sourceFiles(APP_DIR).filter((file) =>
  /export\s+(async\s+)?function\s+generateMetadata\b|export\s+const\s+generateMetadata\b/.test(
    readFileSync(file, 'utf8'),
  ),
);

describe('generateMetadata stays off the network', () => {
  it('finds the pages that export it (a guard against the test going blind)', () => {
    expect(withMetadata.length).toBeGreaterThanOrEqual(2);
  });

  it.each(withMetadata.map((file) => [file.slice(APP_DIR.length)]))(
    '%s imports no catalog or API client and its generateMetadata calls none',
    (relative) => {
      const source = readFileSync(join(APP_DIR, relative), 'utf8');
      const body = metadataBody(source);
      expect(body, 'could not find the function body').not.toBe('');
      expect(body).not.toMatch(FORBIDDEN_CALL);
      // The page file itself imports no fetcher: the landing fetches inside its products section,
      // a module of its own, never in the file that exports the metadata.
      const imports = source.split('\n').filter((line) => /^import\b/.test(line));
      expect(imports.filter((line) => FORBIDDEN_IMPORT.test(line))).toEqual([]);
    },
  );

  it('the shared metadata helper imports no fetcher either', () => {
    const helper = readFileSync(join(__dirname, 'page-metadata.ts'), 'utf8');
    expect(helper).not.toMatch(FORBIDDEN_IMPORT);
    expect(helper).not.toMatch(FORBIDDEN_CALL);
  });
});
