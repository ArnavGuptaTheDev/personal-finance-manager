// Runs every statement fixture in test/fixtures/statements/ through the parser and
// compares the result with its .expected.json (the test diff shows the actual output
// when a new fixture's expected file still needs writing).
import { describe, expect, it } from 'vitest';
import type { AccountType, Bank, ParseResult } from '../../src/client/parsers/statement';
import { parseStatement } from '../../src/client/parsers/statement';
import { csv, d, workbook } from '../unit/statement-builders';

type Fixture = {
  about: string;
  format: `${Bank}:${AccountType}`;
  expectMismatches?: boolean;
  file:
    | { type: 'xls' | 'xlsx'; rows: (string | number | { date: string })[][]; dateFormat?: string; name?: string }
    | { type: 'csv'; lines: string[]; encoding?: 'windows-1252'; name?: string };
};

const files = import.meta.glob<Fixture | ParseResult>('../fixtures/statements/*.json', { eager: true, import: 'default' });
const fixtures = Object.keys(files).filter((path) => !path.endsWith('.expected.json'));

/** Windows-1252 bytes for text in the Latin-1 range (enough for synthetic fixtures). */
function cp1252(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([...text].map((ch) => {
    const code = ch.charCodeAt(0);
    if (code > 0xff) throw new Error(`Character ${ch} is outside the fixture encoder's range`);
    return code;
  }));
}

function build(f: Fixture['file']): File {
  if (f.type === 'csv') {
    const name = f.name ?? 'statement.csv';
    if (f.encoding === 'windows-1252') return new File([cp1252(f.lines.join('\r\n'))], name);
    return csv(f.lines, name);
  }
  const rows = f.rows.map((r) => r.map((c) => (typeof c === 'object' && c !== null ? d(...(c.date.split('-').map(Number) as [number, number, number])) : c)));
  const file = workbook(rows, { dateFormat: f.dateFormat, book: f.type === 'xlsx' ? 'xlsx' : 'biff8' });
  return f.name ? new File([file], f.name) : file;
}

describe('statement fixtures', () => {
  it('has fixtures', () => expect(fixtures.length).toBeGreaterThan(0));

  it.each(fixtures)('%s', async (path) => {
    const fixture = files[path] as Fixture;
    const expected = files[path.replace(/\.json$/, '.expected.json')] as ParseResult | undefined;
    const [bank, account] = fixture.format.split(':') as [Bank, AccountType];
    const result = await parseStatement(build(fixture.file), bank, account);

    expect(result).toEqual(expected);
    if (result.balance && !fixture.expectMismatches) expect(result.balance.mismatches).toBe(0);
    if (fixture.expectMismatches) expect(result.balance?.mismatches).toBeGreaterThan(0);
  });
});
