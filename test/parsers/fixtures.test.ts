// Runs every statement fixture in test/fixtures/statements/ through the parser and
// compares the result with its .expected.json. UPDATE_FIXTURES=1 rewrites the expected
// files (review the diff before committing).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AccountType, Bank } from '../../src/client/parsers/statement';
import { parseStatement } from '../../src/client/parsers/statement';
import { csv, d, workbook } from '../unit/statement-builders';

const DIR = join(__dirname, '../fixtures/statements');

type Fixture = {
  about: string;
  format: `${Bank}:${AccountType}`;
  expectMismatches?: boolean;
  file:
    | { type: 'xls' | 'xlsx'; rows: (string | number | { date: string })[][]; dateFormat?: string; name?: string }
    | { type: 'csv'; lines: string[]; encoding?: 'windows-1252'; name?: string };
};

/** Windows-1252 bytes for text in the Latin-1 range (enough for synthetic fixtures). */
function cp1252(text: string): Uint8Array {
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

const names = readdirSync(DIR).filter((n) => n.endsWith('.json') && !n.endsWith('.expected.json'));

describe('statement fixtures', () => {
  it('has fixtures', () => expect(names.length).toBeGreaterThan(0));

  it.each(names)('%s', async (name) => {
    const fixture = JSON.parse(readFileSync(join(DIR, name), 'utf8')) as Fixture;
    const [bank, account] = fixture.format.split(':') as [Bank, AccountType];
    const result = await parseStatement(build(fixture.file), bank, account);
    const expectedPath = join(DIR, name.replace(/\.json$/, '.expected.json'));

    if (process.env.UPDATE_FIXTURES) writeFileSync(expectedPath, `${JSON.stringify(result, null, 2)}\n`);
    expect(result).toEqual(JSON.parse(readFileSync(expectedPath, 'utf8')));

    if (result.balance && !fixture.expectMismatches) expect(result.balance.mismatches).toBe(0);
    if (fixture.expectMismatches) expect(result.balance?.mismatches).toBeGreaterThan(0);
  });
});
