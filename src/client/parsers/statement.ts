// Bank statement parsing, entirely in the browser: the raw statement file is
// never uploaded. Only the rows the user confirms are sent to the API.
//
// To support a new bank/format, add an entry to FORMATS below.
import { read, utils } from 'xlsx';

export type Bank = 'hdfc' | 'icici';
export type AccountType = 'savings' | 'credit_card';

export type ParsedRow = {
  date: string; // YYYY-MM-DD
  description: string;
  amount: number;
  type: 'debit' | 'credit';
};

export type ParseResult = { rows: ParsedRow[]; last4: string | null };

type Columns = Record<string, number>;

type Format = {
  /** Every group must have at least one alias present in the header row. */
  header: RegExp[];
  columns: Record<string, RegExp[]>;
  last4: RegExp[];
  row: (cells: string[], col: Columns) => ParsedRow | null;
};

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Parses Indian statement dates (day first): 05/04/24, 05-04-2024, 05-Apr-2024, 05 Apr 24, 2024-04-05. */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = s.match(/^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{2,4})(?:\s|$)/))) {
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = s.match(/^(\d{1,2})[/\-. ]([A-Za-z]{3})[A-Za-z]*[/\-., ]+(\d{2,4})(?:\s|$)/))) {
    const mm = MONTHS[match[2]!.toLowerCase()];
    if (!mm) return null;
    [d, m, y] = [Number(match[1]), mm, Number(match[3])];
  } else {
    return null;
  }
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** "1,23,456.78", "₹ 500.00 Cr", "-", "" → number (0 when blank). */
export function parseAmount(raw: string | undefined): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/[₹,\s]|INR|Rs\.?|Cr|Dr/gi, '');
  if (!cleaned || cleaned === '-') return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(Math.abs(n) * 100) / 100 : 0;
}

const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const cell = (cells: string[], col: Columns, key: string) => (col[key] === undefined ? '' : (cells[col[key]!] ?? ''));

function splitDebitCredit(cells: string[], col: Columns): ParsedRow | null {
  const date = parseDate(cell(cells, col, 'date'));
  if (!date) return null;
  const debit = parseAmount(cell(cells, col, 'debit'));
  const credit = parseAmount(cell(cells, col, 'credit'));
  const description = clean(cell(cells, col, 'description'));
  if ((!debit && !credit) || /^b\/f$/i.test(description)) return null;
  return debit > 0
    ? { date, description, amount: debit, type: 'debit' }
    : { date, description, amount: credit, type: 'credit' };
}

const FORMATS: Record<`${Bank}:${AccountType}`, Format> = {
  'hdfc:savings': {
    header: [/^date$/, /narration/, /withdrawal/],
    columns: { date: [/^date$/], description: [/narration/], debit: [/withdrawal/], credit: [/deposit/] },
    last4: [/(?:account|a\/c)\s*(?:no|number)\.?\s*[:\-]?\s*[x*\d\s]*?(\d{4})(?!\d)/i],
    row: splitDebitCredit,
  },
  'hdfc:credit_card': {
    header: [/date/, /description/, /amt|amount/],
    columns: { date: [/^date/, /date/], description: [/description/], amount: [/amt|amount/], sign: [/debit\s*\/\s*credit|cr\/dr|dr\/cr/] },
    last4: [/card\s*(?:no|number)\.?\s*[:\-]?\s*[x*\d\s]*?(\d{4})(?!\d)/i],
    row: (cells, col) => {
      const date = parseDate(cell(cells, col, 'date'));
      const rawAmount = cell(cells, col, 'amount');
      const amount = parseAmount(rawAmount);
      if (!date || !amount) return null;
      const credit = /cr/i.test(cell(cells, col, 'sign')) || /\bcr\b/i.test(rawAmount);
      return { date, description: clean(cell(cells, col, 'description')), amount, type: credit ? 'credit' : 'debit' };
    },
  },
  'icici:savings': {
    header: [/date/, /particulars|remarks/, /withdrawal/],
    columns: {
      date: [/^transaction date$/, /^date$/, /date/],
      description: [/particulars/, /transaction remarks/, /remarks/],
      debit: [/withdrawal/],
      credit: [/deposit/],
    },
    last4: [/(?:account|a\/c)\s*(?:no|number)?\.?\s*[:\-]?\s*[x*\d\s]*?(\d{4})(?!\d)/i],
    row: splitDebitCredit,
  },
  'icici:credit_card': {
    header: [/^date$/, /transaction details|details/, /amount/],
    columns: {
      date: [/^date$/],
      description: [/transaction details/, /details/],
      amount: [/amount\s*\(in rs\)/, /amount.*rs/, /^amount/],
      sign: [/billingamountsign|sign/],
      ref: [/^sr\.?\s*no/],
    },
    last4: [/x{2,}[x\d\s\-]*?(\d{4})(?!\d)/i, /card\s*(?:no|number)?\.?\s*[:\-]?\s*[x*\d\s\-]*?(\d{4})(?!\d)/i],
    row: (cells, col) => {
      const date = parseDate(cell(cells, col, 'date'));
      const amount = parseAmount(cell(cells, col, 'amount'));
      if (!date || !amount) return null;
      const credit = /cr/i.test(cell(cells, col, 'sign'));
      const ref = clean(cell(cells, col, 'ref'));
      const description = clean(cell(cells, col, 'description')) + (ref ? ` (Sr:${ref})` : '');
      return { date, description, amount, type: credit ? 'credit' : 'debit' };
    },
  },
};

function findHeader(rows: string[][], format: Format): number {
  return rows.findIndex((r) => {
    const cells = r.map((c) => clean(c).toLowerCase());
    return format.header.every((re) => cells.some((c) => re.test(c)));
  });
}

function mapColumns(header: string[], format: Format): Columns {
  const cells = header.map((c) => clean(c).toLowerCase());
  const col: Columns = {};
  for (const [key, aliases] of Object.entries(format.columns)) {
    for (const re of aliases) {
      const idx = cells.findIndex((c, i) => re.test(c) && !Object.values(col).includes(i));
      if (idx >= 0) {
        col[key] = idx;
        break;
      }
    }
  }
  return col;
}

async function readRows(file: File): Promise<string[][]> {
  const buf = await file.arrayBuffer();
  // raw: true keeps CSV cells as text so SheetJS never reinterprets day-first dates.
  const wb = read(buf, { type: 'array', raw: file.name.toLowerCase().endsWith('.csv'), dense: true });
  const sheet = wb.Sheets[wb.SheetNames[0]!];
  if (!sheet) return [];
  return utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '', blankrows: false });
}

export async function parseStatement(file: File, bank: Bank, account: AccountType): Promise<ParseResult> {
  if (file.size > MAX_FILE_BYTES) throw new Error('File is larger than 5 MB');
  if (!/\.(csv|xls|xlsx)$/i.test(file.name)) throw new Error('Upload a .csv, .xls or .xlsx statement');

  const format = FORMATS[`${bank}:${account}`];
  const rows = await readRows(file);
  const headerIdx = findHeader(rows, format);
  if (headerIdx < 0) {
    throw new Error(`Couldn't find the transaction table. Is this a ${bank.toUpperCase()} ${account === 'savings' ? 'savings' : 'credit card'} statement?`);
  }
  const col = mapColumns(rows[headerIdx]!, format);
  if (col.date === undefined) throw new Error('Statement has no date column');

  const preamble = rows.slice(0, headerIdx).flat().join(' ');
  const last4 = format.last4.map((re) => preamble.match(re)?.[1]).find(Boolean) ?? null;

  // Transactions start at the first row with a valid date and end at the first
  // row without one after that (footer, summary, "End of statement" etc.).
  const parsed: ParsedRow[] = [];
  let started = false;
  for (const r of rows.slice(headerIdx + 1)) {
    const hasDate = parseDate(cell(r, col, 'date')) !== null;
    if (!hasDate) {
      if (started) break;
      continue;
    }
    started = true;
    const row = format.row(r, col);
    if (row && row.description) parsed.push(row);
  }
  if (!parsed.length) throw new Error('No transactions found in this file');

  parsed.sort((a, b) => a.date.localeCompare(b.date));
  return { rows: parsed, last4 };
}
