// Bank statement parsing, entirely in the browser: the raw statement file is
// never uploaded. Only the rows the user confirms are sent to the API.
//
// Layouts are configuration (see formats.ts); this file holds the one parser they share.
import { read, SSF, utils, type CellObject, type WorkSheet } from 'xlsx';
import { BUILTIN_FORMATS, type BuiltinFormatId, type DateOrder, type FormatConfig } from './formats';

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
  /** Where last4 came from, so the review can say so (the person can still correct it). */
  last4Source: 'statement' | 'file name' | null;
  /** Rows inside the table that were not imported, with the reason. Nothing is dropped silently. */
  skipped: SkippedRow[];
  /** Wrapped description lines that were joined onto the transaction above them. */
  joined: number;
  /** Running-balance check, when the statement has a balance column. */
  balance: { checked: number; mismatches: number } | null;
};

type Columns = Partial<Record<string, number>>;

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/**
 * Parses statement dates. Indian statements are day first (05/04/24, 05-04-2024,
 * 05-Apr-2024, 05 Apr 24); ISO dates (2024-04-05) are always read as such. `order`
 * only changes how all-numeric dates are read, for hand-mapped formats.
 */
export function parseDate(raw: string, order: DateOrder = 'dmy'): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let match = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = s.match(/^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{2,4})(?:\s|$)/))) {
    const [a, b] = [Number(match[1]), Number(match[2])];
    [d, m] = order === 'mdy' ? [b, a] : [a, b];
    y = Number(match[3]);
    if (order === 'ymd') return null;
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
const balanceNote = (expected: number, shown: number) =>
  `Running balance doesn't add up here (expected ${expected.toFixed(2)}, statement shows ${shown.toFixed(2)}): a row nearby may be missing or misread`;

/** An amount from a "money out" or "money in" column becomes a debit or credit; a negative flips it. */
function signed(date: string, description: string, amount: number, out: boolean, note?: string): ParsedRow {
  const debit = amount < 0 ? !out : out;
  const flag = note ?? (amount < 0 ? NEGATIVE_NOTE : undefined);
  return { date, description, amount: Math.abs(amount), type: debit ? 'debit' : 'credit', ...(flag ? { note: flag } : {}) };
}

/** One statement row → zero, one or (debit and credit both filled) two transactions. */
function rowTransactions(cells: string[], col: Columns, fmt: FormatConfig): ParsedRow[] {
  const date = parseDate(cell(cells, col, 'date'), fmt.dateOrder);
  if (!date) return [];
  const text = clean(cell(cells, col, 'description'));

  if (fmt.amounts === 'split') {
    const debit = parseAmount(cell(cells, col, 'debit'));
    const credit = parseAmount(cell(cells, col, 'credit'));
    if (fmt.carryOver?.test(text)) return [];
    // Both columns filled is unusual: keep both halves and flag them rather than lose one.
    const both = debit !== 0 && credit !== 0 ? BOTH_NOTE : undefined;
    const out: ParsedRow[] = [];
    if (debit) out.push(signed(date, text, debit, true, both));
    if (credit) out.push(signed(date, text, credit, false, both));
    return out;
  }

  const raw = cell(cells, col, 'amount');
  const amount = parseAmount(raw);
  if (!amount || fmt.carryOver?.test(text)) return [];
  const ref = fmt.appendRef ? clean(cell(cells, col, 'ref')) : '';
  const description = text + (ref ? ` (Sr:${ref})` : '');

  if (fmt.amounts === 'marker') {
    const marker = fmt.creditMarker ?? /cr/i;
    const credit = marker.test(cell(cells, col, 'sign')) || (fmt.markerInAmount === true && /\bcr\b/i.test(raw));
    return [signed(date, description, amount, !credit)];
  }
  const negativeIsDebit = fmt.amounts === 'negative-debit';
  const isDebit = amount < 0 ? negativeIsDebit : !negativeIsDebit;
  return [{ date, description, amount: Math.abs(amount), type: isDebit ? 'debit' : 'credit' }];
}

/** "4321 XXXX XXXX 9876" or "XXXXXXXX5678" → "9876" / "5678": the final four digits of the number. */
function lastFour(number: string | undefined): string | null {
  return number?.replace(/[\s-]/g, '').match(/(\d{4})$/)?.[1] ?? null;
}

/** File names like "Acct_XXXX1234_Apr.xls" or "card-9876.csv" carry the last four digits too. */
function lastFourFromName(name: string): string | null {
  const m = name.match(/(?:acc(?:oun)?t|a\/c|card|x{2,})[^0-9]{0,12}(?:\d*?)(\d{4})(?!\d)/i);
  return m?.[1] ?? null;
}

const lower = (cells: string[]) => cells.map((c) => clean(c).toLowerCase());
const matchesHeader = (cells: string[], fmt: FormatConfig) => fmt.header.every((re) => cells.some((c) => re.test(c)));

/**
 * The header row, or two stacked header rows read as one ("Withdrawal" above "Amt."
 * becomes "withdrawal amt."). Returns its cells and the first row after it.
 */
export function findHeader(rows: string[][], fmt: FormatConfig): { index: number; cells: string[]; next: number } | null {
  for (let i = 0; i < rows.length; i++) {
    const cells = lower(rows[i]!);
    if (matchesHeader(cells, fmt)) return { index: i, cells, next: i + 1 };
    const below = rows[i + 1];
    if (!below || !cells.some(Boolean)) continue;
    const width = Math.max(cells.length, below.length);
    const merged = Array.from({ length: width }, (_, c) => clean(`${cells[c] ?? ''} ${(below[c] ?? '').toLowerCase()}`));
    if (matchesHeader(merged, fmt)) return { index: i, cells: merged, next: i + 2 };
  }
  return null;
}

function mapColumns(header: string[], fmt: FormatConfig): Columns {
  const col: Columns = {};
  for (const [key, aliases] of Object.entries(fmt.columns)) {
    for (const re of aliases ?? []) {
      const idx = header.findIndex((c, i) => re.test(c) && !Object.values(col).includes(i));
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

/**
 * CSV bytes → text. UTF-8 (with or without BOM) and UTF-16 are recognised; anything
 * that isn't valid UTF-8 is read as Windows-1252, which is what Excel on Windows writes.
 */
export function decodeCsv(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return decode1252(body);
  }
}

// Bytes 0x80–0x9F, where Windows-1252 differs from Latin-1 (not every runtime's decoder maps them).
const CP1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';

function decode1252(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b);
  return out;
}

export function checkFile(file: File) {
  if (file.size > MAX_FILE_BYTES) throw new Error('File is larger than 5 MB');
  if (!/\.(csv|xls|xlsx)$/i.test(file.name)) throw new Error('Upload a .csv, .xls or .xlsx statement');
}

/** Every row of the first sheet as text cells. */
export async function readStatementRows(file: File): Promise<string[][]> {
  checkFile(file);
  const buf = new Uint8Array(await file.arrayBuffer());
  // raw: true keeps CSV cells as text so SheetJS never reinterprets day-first dates;
  // cellNF keeps number formats so Excel date cells can be recognised.
  const wb = file.name.toLowerCase().endsWith('.csv')
    ? read(decodeCsv(buf), { type: 'string', raw: true })
    : read(buf, { type: 'array', cellNF: true });
  const sheet = wb.Sheets[wb.SheetNames[0]!];
  return sheet ? sheetRows(sheet) : [];
}

// Undated rows after the transactions that mark the end of the table.
const FOOTER = /statement summary|opening balance|closing balance|end of statement|computer generated|generated on|page \d+ of|^totals?\b|dr count|cr count|legends?\b/i;

/** Thrown when no known layout fits; the Import page then offers manual column mapping. */
export class UnrecognisedStatementError extends Error {}

type StatementRow = { out: ParsedRow[]; balance: number | null };

/**
 * Checks each row against the running balance. Statements can be oldest-first or
 * newest-first, so both readings are tried and the one that fits more rows is used.
 */
function checkBalances(seq: StatementRow[]): { checked: number; mismatches: number } {
  const net = (r: StatementRow) => r.out.reduce((s, p) => s + (p.type === 'credit' ? p.amount : -p.amount), 0);
  const close = (a: number, b: number) => Math.abs(a - b) < 0.005;
  const rows = seq.filter((r) => r.balance !== null);
  if (rows.length < 2) return { checked: 0, mismatches: 0 };
  // Oldest first: each balance = the previous row's balance + this row's net amount.
  const forward = rows.slice(1).map((r, i) => ({ r, expected: rows[i]!.balance! + net(r) }));
  // Newest first: each balance = the next (older) row's balance + this row's net amount.
  const backward = rows.slice(0, -1).map((r, i) => ({ r, expected: rows[i + 1]!.balance! + net(r) }));
  const fits = (pairs: typeof forward) => pairs.filter(({ r, expected }) => close(expected, r.balance!)).length;
  const pairs = fits(backward) > fits(forward) ? backward : forward;
  let mismatches = 0;
  for (const { r, expected } of pairs) {
    if (close(expected, r.balance!)) continue;
    mismatches++;
    for (const p of r.out) p.note ??= balanceNote(expected, r.balance!);
  }
  return { checked: pairs.length, mismatches };
}

/** Parses rows with one layout. Throws UnrecognisedStatementError if the layout doesn't fit. */
export function parseRows(rows: string[][], fmt: FormatConfig, fileName = ''): ParseResult {
  const header = findHeader(rows, fmt);
  if (!header) throw new UnrecognisedStatementError(`Couldn't find the transaction table for ${fmt.label}.`);
  const col = mapColumns(header.cells, fmt);
  if (col.date === undefined) throw new UnrecognisedStatementError('Statement has no date column');

  const preamble = rows.slice(0, header.index).flat().join(' ');
  const fromStatement = fmt.accountNumber.map((re) => lastFour(preamble.match(re)?.[1])).find(Boolean) ?? null;
  const fromName = fromStatement ? null : lastFourFromName(fileName);
  const last4 = fromStatement ?? fromName;

  // Transactions start at the first dated row after the header and end at a footer
  // row. Undated rows in between are wrapped descriptions (joined to the row above)
  // or are reported as skipped; they never end the import early.
  const parsed: ParsedRow[] = [];
  const sequence: StatementRow[] = [];
  const skipped: SkippedRow[] = [];
  let joined = 0;
  let previous: ParsedRow[] = [];
  let started = false;
  const amountKeys = ['debit', 'credit', 'amount'].filter((k) => col[k] !== undefined);

  for (let i = header.next; i < rows.length; i++) {
    const r = rows[i]!;
    const text = r.map(clean).filter(Boolean).join(' ');
    if (!/[a-z0-9]/i.test(text)) continue; // blank or decoration ("*****")

    const rawDate = clean(cell(r, col, 'date'));
    if (parseDate(rawDate, fmt.dateOrder)) {
      started = true;
      const out = rowTransactions(r, col, fmt).filter((p) => p.description);
      const balanceText = clean(cell(r, col, 'balance'));
      const balance = col.balance !== undefined && balanceText ? parseAmount(balanceText) : null;
      if (out.length) {
        parsed.push(...out);
        previous = out;
      } else {
        const carry = fmt.carryOver?.test(clean(cell(r, col, 'description'))) ?? false;
        skipped.push({ line: i + 1, reason: carry ? 'Balance brought forward' : 'No amount', text });
        previous = [];
      }
      // A carried-over balance row still anchors the running-balance check.
      sequence.push({ out, balance });
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
  if (!parsed.length) throw new UnrecognisedStatementError('No transactions found in this file');

  const balance = col.balance !== undefined ? checkBalances(sequence) : null;
  parsed.sort((a, b) => a.date.localeCompare(b.date));
  return { rows: parsed, last4, last4Source: fromStatement ? 'statement' : fromName ? 'file name' : null, skipped, joined, balance };
}

export async function parseStatementWith(file: File, fmt: FormatConfig): Promise<ParseResult> {
  return parseRows(await readStatementRows(file), fmt, file.name);
}

export async function parseStatement(file: File, bank: Bank, account: AccountType): Promise<ParseResult> {
  const id: BuiltinFormatId = `${bank}:${account}`;
  try {
    return await parseStatementWith(file, BUILTIN_FORMATS[id]);
  } catch (err) {
    if (err instanceof UnrecognisedStatementError && err.message.startsWith("Couldn't find")) {
      throw new UnrecognisedStatementError(
        `Couldn't find the transaction table. Is this a ${bank.toUpperCase()} ${account === 'savings' ? 'savings' : 'credit card'} statement?`,
      );
    }
    throw err;
  }
}
