// Bank statement parsing, entirely in the browser: the raw statement file is
// never uploaded. Only the rows the user confirms are sent to the API.
//
// To support a new bank/format, add an entry to FORMATS below.
import { read, SSF, utils, type CellObject, type WorkSheet } from 'xlsx';

export type Bank = 'hdfc' | 'icici';
export type AccountType = 'savings' | 'credit_card';

export type ParsedRow = {
  date: string; // YYYY-MM-DD
  description: string;
  amount: number;
  type: 'debit' | 'credit';
  /** Set when the row needs a human look before importing (shown in review, unticked). */
  note?: string;
};

export type SkippedRow = { line: number; reason: string; text: string };

export type ParseResult = {
  rows: ParsedRow[];
  last4: string | null;
  /** Rows inside the table that were not imported, with the reason. Nothing is dropped silently. */
  skipped: SkippedRow[];
  /** Wrapped description lines that were joined onto the transaction above them. */
  joined: number;
};

type Columns = Record<string, number>;

type Format = {
  /** Every group must have at least one alias present in the header row. */
  header: RegExp[];
  columns: Record<string, RegExp[]>;
  last4: RegExp[];
  row: (cells: string[], col: Columns) => ParsedRow[];
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

/** "1,23,456.78", "₹ 500.00 Cr", "(150.00)", "-150", "-", "" → signed number (0 when blank). */
export function parseAmount(raw: string | undefined): number {
  if (!raw) return 0;
  let cleaned = raw.replace(/[₹,\s]|INR|Rs\.?|Cr|Dr/gi, '');
  if (/^\(.*\)$/.test(cleaned)) cleaned = `-${cleaned.slice(1, -1)}`;
  if (!cleaned || cleaned === '-') return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const cell = (cells: string[], col: Columns, key: string) => (col[key] === undefined ? '' : (cells[col[key]!] ?? ''));

const NEGATIVE_NOTE = 'Negative amount in the statement, imported as the opposite direction (e.g. a reversal)';
const BOTH_NOTE = 'This statement row had both a withdrawal and a deposit; check before importing';

/** An amount from a "money out" or "money in" column becomes a debit or credit; a negative flips it. */
function signed(date: string, description: string, amount: number, out: boolean, note?: string): ParsedRow {
  const debit = amount < 0 ? !out : out;
  const flag = note ?? (amount < 0 ? NEGATIVE_NOTE : undefined);
  return { date, description, amount: Math.abs(amount), type: debit ? 'debit' : 'credit', ...(flag ? { note: flag } : {}) };
}

function splitDebitCredit(cells: string[], col: Columns): ParsedRow[] {
  const date = parseDate(cell(cells, col, 'date'));
  if (!date) return [];
  const debit = parseAmount(cell(cells, col, 'debit'));
  const credit = parseAmount(cell(cells, col, 'credit'));
  const description = clean(cell(cells, col, 'description'));
  if (/^b\/f$/i.test(description)) return [];
  // Both columns filled is unusual: keep both halves and flag them rather than lose one.
  const both = debit !== 0 && credit !== 0 ? BOTH_NOTE : undefined;
  const out: ParsedRow[] = [];
  if (debit) out.push(signed(date, description, debit, true, both));
  if (credit) out.push(signed(date, description, credit, false, both));
  return out;
}

const FORMATS: Record<`${Bank}:${AccountType}`, Format> = {
  'hdfc:savings': {
    header: [/^date$/, /narration/, /withdrawal/],
    columns: { date: [/^date$/], description: [/narration/], debit: [/withdrawal/], credit: [/deposit/] },
    last4: [/(?:account|a\/c)\s*(?:no|number)\.?\s*[:\-]?\s*([x*\d][x*\d\s-]*\d)/i],
    row: splitDebitCredit,
  },
  'hdfc:credit_card': {
    header: [/date/, /description/, /amt|amount/],
    columns: { date: [/^date/, /date/], description: [/description/], amount: [/amt|amount/], sign: [/debit\s*\/\s*credit|cr\/dr|dr\/cr/] },
    last4: [/card\s*(?:no|number)\.?\s*[:\-]?\s*([x*\d][x*\d\s-]*\d)/i],
    row: (cells, col) => {
      const date = parseDate(cell(cells, col, 'date'));
      const rawAmount = cell(cells, col, 'amount');
      const amount = parseAmount(rawAmount);
      if (!date || !amount) return [];
      const credit = /cr/i.test(cell(cells, col, 'sign')) || /\bcr\b/i.test(rawAmount);
      return [signed(date, clean(cell(cells, col, 'description')), amount, !credit)];
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
    last4: [/(?:account|a\/c)\s*(?:no|number)?\.?\s*[:\-,]?\s*([x*\d][x*\d\s-]*\d)/i],
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
    last4: [/([x*\d]*x{2,}[x*\d\s-]*\d)/i, /card\s*(?:no|number)?\.?\s*[:\-,]?\s*([x*\d][x*\d\s-]*\d)/i],
    row: (cells, col) => {
      const date = parseDate(cell(cells, col, 'date'));
      const amount = parseAmount(cell(cells, col, 'amount'));
      if (!date || !amount) return [];
      const credit = /cr/i.test(cell(cells, col, 'sign'));
      const ref = clean(cell(cells, col, 'ref'));
      const description = clean(cell(cells, col, 'description')) + (ref ? ` (Sr:${ref})` : '');
      return [signed(date, description, amount, !credit)];
    },
  },
};

/** "4321 XXXX XXXX 9876" or "XXXXXXXX5678" → "9876" / "5678": the final four digits of the number. */
function lastFour(number: string | undefined): string | null {
  return number?.replace(/[\s-]/g, '').match(/(\d{4})$/)?.[1] ?? null;
}

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

const iso = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Cell → text. Real Excel date cells are converted from their stored serial value,
 * never from their display text: a cell shown as "4/5/26" under an m/d/yy format
 * is 5 April, and reading that text day-first would turn it into 4 May.
 */
function cellText(c: CellObject | undefined): string {
  if (!c || c.v === undefined || c.v === null) return '';
  if (c.t === 'n' && typeof c.v === 'number') {
    if (c.z && SSF.is_date(c.z)) {
      const p = SSF.parse_date_code(c.v);
      return iso(p.y, p.m, p.d);
    }
    return String(c.v);
  }
  if (c.t === 'd' && c.v instanceof Date) return iso(c.v.getUTCFullYear(), c.v.getUTCMonth() + 1, c.v.getUTCDate());
  return String(c.v);
}

function sheetRows(sheet: WorkSheet): string[][] {
  if (!sheet['!ref']) return [];
  const range = utils.decode_range(sheet['!ref']);
  const rows: string[][] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) row.push(cellText(sheet[utils.encode_cell({ r, c })]));
    rows.push(row);
  }
  return rows;
}

async function readRows(file: File): Promise<string[][]> {
  const buf = await file.arrayBuffer();
  // raw: true keeps CSV cells as text so SheetJS never reinterprets day-first dates;
  // cellNF keeps number formats so Excel date cells can be recognised.
  const wb = read(buf, { type: 'array', raw: file.name.toLowerCase().endsWith('.csv'), cellNF: true });
  const sheet = wb.Sheets[wb.SheetNames[0]!];
  return sheet ? sheetRows(sheet) : [];
}

// Undated rows after the transactions that mark the end of the table.
const FOOTER = /statement summary|opening balance|closing balance|end of statement|computer generated|generated on|page \d+ of|^totals?\b|dr count|cr count|legends?\b/i;

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
  const last4 = format.last4.map((re) => lastFour(preamble.match(re)?.[1])).find(Boolean) ?? null;

  // Transactions start at the first dated row after the header and end at a footer
  // row. Undated rows in between are wrapped descriptions (joined to the row above)
  // or are reported as skipped; they never end the import early.
  const parsed: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];
  let joined = 0;
  let previous: ParsedRow[] = [];
  let started = false;
  const amountKeys = ['debit', 'credit', 'amount'].filter((k) => col[k] !== undefined);

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i]!;
    const text = r.map(clean).filter(Boolean).join(' ');
    if (!/[a-z0-9]/i.test(text)) continue; // blank or decoration ("*****")

    const rawDate = clean(cell(r, col, 'date'));
    if (parseDate(rawDate)) {
      started = true;
      const out = format.row(r, col).filter((p) => p.description);
      if (out.length) {
        parsed.push(...out);
        previous = out;
      } else {
        const bf = /^b\/f$/i.test(clean(cell(r, col, 'description')));
        skipped.push({ line: i + 1, reason: bf ? 'Balance brought forward' : 'No amount', text });
        previous = [];
      }
      continue;
    }
    if (!started) continue;
    if (FOOTER.test(text)) break;

    const description = clean(cell(r, col, 'description'));
    const hasAmount = amountKeys.some((k) => parseAmount(cell(r, col, k)) !== 0);
    if (!rawDate && description && !hasAmount && previous.length) {
      for (const p of previous) p.description = `${p.description} ${description}`;
      joined++;
    } else {
      skipped.push({ line: i + 1, reason: hasAmount ? 'Has an amount but no readable date' : 'Not a transaction row', text });
    }
  }
  if (!parsed.length) throw new Error('No transactions found in this file');

  parsed.sort((a, b) => a.date.localeCompare(b.date));
  return { rows: parsed, last4, skipped, joined };
}
