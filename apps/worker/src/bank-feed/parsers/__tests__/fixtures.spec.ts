import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBankMessage } from '../parse-bank-message';
import { FIXTURE_EXPECTATIONS } from './expectations';
import { FIXTURE_HEADER, loadFixture } from './synthetic';

const FIXTURE_DIR = join(__dirname, '..', '__fixtures__');

describe('bank message fixtures', () => {
  it.each(FIXTURE_EXPECTATIONS)('%s → expected fields', (name, source, expected) => {
    expect(parseBankMessage(source, loadFixture(name))).toEqual(expected);
  });

  it('every fixture file is covered by an expectation', () => {
    const files = readdirSync(FIXTURE_DIR).sort();
    expect(files).toEqual(FIXTURE_EXPECTATIONS.map(([name]) => name).sort());
  });

  it('every fixture file starts with the synthetic header', () => {
    for (const file of readdirSync(FIXTURE_DIR)) {
      const firstLine = readFileSync(join(FIXTURE_DIR, file), 'utf8').split(/\r?\n/)[0];
      expect(firstLine).toBe(FIXTURE_HEADER);
    }
  });

  it('the header line itself is never part of the parsed text', () => {
    const raw = readFileSync(join(FIXTURE_DIR, 'humo.uz.credit.txt'), 'utf8');
    // Read with the header kept, the comment is a stray unmarked title, never a field.
    expect(parseBankMessage('HUMO_BOT', raw)).toEqual({ ok: false, reason: 'UNEXPECTED_LINE' });
  });

  it('the FE0F, NBSP and CRLF fixtures really contain those characters', () => {
    expect(loadFixture('edge.humo.fe0f.txt')).toContain('\uFE0F');
    expect(loadFixture('edge.humo.nbsp.txt')).toContain('\u00A0');
    expect(loadFixture('edge.humo.nbsp.txt')).toContain('\u202F');
    expect(loadFixture('edge.uzcard.thin-space.txt')).toContain('\u2009');
    expect(loadFixture('edge.uzcard.crlf-blank-lines.txt')).toMatch(/\r\n *\r\n/);
  });

  it('amounts are exact bigint tiyin', () => {
    const parsed = parseBankMessage('UZCARD_BOT', loadFixture('uzcard.ru.credit.txt'));
    expect(parsed.ok && typeof parsed.amountTiyin).toBe('bigint');
    expect(parsed.ok && typeof parsed.balanceAfterTiyin).toBe('bigint');
  });
});
