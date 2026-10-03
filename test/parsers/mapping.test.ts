import { describe, expect, it } from 'vitest';
import { BUILTIN_FORMATS, mappingProblem, mappingToFormat } from '../../src/client/parsers/formats';
import { guessChoice, toMapping } from '../../src/client/parsers/mapping';
import { decodeCsv, findHeader, parseRows, parseStatement, readStatementRows, UnrecognisedStatementError } from '../../src/client/parsers/statement';
import { csv } from '../unit/statement-builders';

// A layout no built-in format knows: different titles, one signed amount column.
const OTHER_BANK = [
  'Test Bank of Nowhere',
  'A/c No: 000011112222',
  '',
  'Txn Date,Value Date,Details,Ref,Amount (INR),Running Total',
  '01-09-2026,01-09-2026,SALARY TEST CORP,R1,"40,000.00","45,000.00"',
  '03-09-2026,03-09-2026,UPI DMART,R2,-1250.50,"43,749.50"',
  '07-09-2026,07-09-2026,UPI CHAI POINT,R3,-80.00,"43,669.50"',
];

describe('unrecognised statements', () => {
  it('raise UnrecognisedStatementError, which sends the person to column mapping', async () => {
    await expect(parseStatement(csv(OTHER_BANK), 'hdfc', 'savings')).rejects.toBeInstanceOf(UnrecognisedStatementError);
  });

  it('are guessed well enough to map in a couple of clicks, then parse fully', async () => {
    const rows = await readStatementRows(csv(OTHER_BANK));
    const choice = guessChoice(rows);
    expect(choice.header).toBe(3);
    expect(choice.amounts).toBe('negative-debit');
    expect(choice.columns).toMatchObject({ date: 0, description: 2, amount: 4, balance: 5 });

    const mapping = toMapping(rows, choice);
    expect(mapping).toEqual({
      version: 1,
      columns: { date: 'Txn Date', description: 'Details', amount: 'Amount (INR)', balance: 'Running Total' },
      amounts: 'negative-debit',
      dateOrder: 'dmy',
    });
    expect(mappingProblem(mapping)).toBeNull();

    const result = parseRows(rows, mappingToFormat(mapping, 'Test Bank'), 'statement.csv');
    expect(result.rows.map((r) => `${r.date} ${r.type} ${r.amount} ${r.description}`)).toEqual([
      '2026-09-01 credit 40000 SALARY TEST CORP',
      '2026-09-03 debit 1250.5 UPI DMART',
      '2026-09-07 debit 80 UPI CHAI POINT',
    ]);
    expect(result.balance).toEqual({ checked: 2, mismatches: 0 });
    expect(result.last4).toBe('2222');
  });

  it('a saved mapping is found again in a later statement with the same titles', async () => {
    const mapping = toMapping(await readStatementRows(csv(OTHER_BANK)), guessChoice(await readStatementRows(csv(OTHER_BANK))));
    const later = ['Txn Date,Value Date,Details,Ref,Amount (INR),Running Total', '02-10-2026,02-10-2026,UPI BOOKS,R9,-300.00,"100.00"'];
    const result = parseRows(await readStatementRows(csv(later)), mappingToFormat(mapping));
    expect(result.rows).toEqual([{ date: '2026-10-02', description: 'UPI BOOKS', amount: 300, type: 'debit' }]);
  });

  it('reports what is missing from an incomplete mapping', () => {
    expect(mappingProblem({ version: 1, columns: { date: 'Date' }, amounts: 'split', dateOrder: 'dmy' })).toMatch(/description/);
    expect(mappingProblem({ version: 1, columns: { date: 'D', description: 'X' }, amounts: 'marker', dateOrder: 'dmy' })).toMatch(/amount/);
    expect(mappingProblem({ version: 1, columns: { date: 'D', description: 'X', amount: 'A' }, amounts: 'marker', dateOrder: 'dmy' })).toMatch(/Cr\/Dr/);
  });

  it('month-first dates can be chosen for a hand-mapped format', async () => {
    const rows = await readStatementRows(csv(['Date,Memo,Amount', '04/05/2026,TEST,-10.00']));
    const fmt = mappingToFormat({ version: 1, columns: { date: 'Date', description: 'Memo', amount: 'Amount' }, amounts: 'negative-debit', dateOrder: 'mdy' });
    expect(parseRows(rows, fmt).rows[0]?.date).toBe('2026-04-05');
  });
});

describe('header detection', () => {
  it('finds a header split over two rows', () => {
    const rows = [['Date', 'Narration', 'Amount', 'Amount'], ['', '', 'Withdrawal', 'Deposit'], ['01/04/26', 'X', '1', '']];
    const found = findHeader(rows, BUILTIN_FORMATS['hdfc:savings']);
    expect(found).toEqual({ index: 0, cells: ['date', 'narration', 'amount withdrawal', 'amount deposit'], next: 2 });
  });
});

describe('CSV encodings', () => {
  const text = 'Café,José,₹';
  it('reads UTF-8 with and without a BOM', () => {
    const utf8 = new TextEncoder().encode(text);
    expect(decodeCsv(utf8)).toBe(text);
    expect(decodeCsv(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8]))).toBe(text);
  });
  it('reads UTF-16 LE with a BOM', () => {
    const bytes = [0xff, 0xfe];
    for (const ch of text) bytes.push(ch.charCodeAt(0) & 0xff, ch.charCodeAt(0) >> 8);
    expect(decodeCsv(Uint8Array.from(bytes))).toBe(text);
  });
  it('falls back to Windows-1252 when the bytes are not valid UTF-8', () => {
    expect(decodeCsv(Uint8Array.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x80]))).toBe('Café €');
  });
});
