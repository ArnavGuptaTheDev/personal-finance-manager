// Synthetic statements modelled on the layouts the parser supports. Every value is
// invented; real statements (even anonymised) are never committed to this repo.
import { utils, write } from 'xlsx';

type Cell = string | number | Date | null;

/** Builds a workbook. Date objects become real Excel date cells with the given display format. */
export function workbook(rows: Cell[][], opts: { dateFormat?: string; book?: 'biff8' | 'xlsx' } = {}): File {
  const ws = utils.aoa_to_sheet(rows, { cellDates: true });
  for (const key of Object.keys(ws)) {
    const c = ws[key];
    if (key.startsWith('!') || !c) continue;
    if (c.t === 'd') {
      // Store as Excel serial numbers with a date format, as Excel itself does.
      const d = c.v as Date;
      c.t = 'n';
      c.v = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(1899, 11, 30)) / 86_400_000;
      c.z = opts.dateFormat ?? 'm/d/yy';
      delete c.w;
    }
  }
  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, 'Sheet1');
  const book = opts.book ?? 'biff8';
  const buf = write(wb, { type: 'array', bookType: book }) as ArrayBuffer;
  return new File([buf], book === 'xlsx' ? 'statement.xlsx' : 'statement.xls');
}

export function csv(lines: string[], name = 'statement.csv'): File {
  return new File([lines.join('\r\n')], name, { type: 'text/csv' });
}

export const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

export const HDFC_SAVINGS_HEADER = ['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'];

/** HDFC savings net-banking .xls: preamble, header, star row, transactions, footer. */
export function hdfcSavings(body: Cell[][], opts?: Parameters<typeof workbook>[1]) {
  return workbook(
    [
      ['HDFC BANK Ltd.', '', '', '', 'Page No .: 1'],
      ['MR TEST USER'],
      ['Account Branch : TEST BRANCH'],
      ['Account No : 50100000001234   OTHER'],
      ['Statement From : 01/04/2026 To : 30/04/2026'],
      [],
      HDFC_SAVINGS_HEADER,
      ['********', '********', '********', '********', '********', '********', '********'],
      ...body,
      [],
      ['STATEMENT SUMMARY :-'],
      ['Opening Balance', 'Dr Count', 'Cr Count', 'Debits', 'Credits', 'Closing Bal'],
      ['10,000.00', '3', '1', '1,500.00', '5,000.00', '13,500.00'],
      ['Generated On: 01/05/2026 This is a computer generated statement'],
    ],
    opts,
  );
}

/** HDFC credit card .xls: amount column plus a Cr marker column. */
export function hdfcCard(body: Cell[][]) {
  return workbook([
    ['Card No : 4321 XXXX XXXX 9876'],
    ['Statement Date : 15/04/2026'],
    [],
    ['Transaction type', 'Primary / Addon Customer Name', 'DATE', 'Description', 'AMT', 'Debit / Credit'],
    ...body,
    [],
    ['Total Dues', '', '', '', '12,345.00'],
  ]);
}

/** ICICI savings iMobile-style CSV. */
export function iciciSavingsCsv(body: string[]) {
  return csv([
    'Account Number,XXXXXXXX5678',
    'Transaction Period,From 01/04/2026 To 30/04/2026',
    '',
    'S No.,Date,Mode,Particulars,Deposits,Withdrawals,Balance',
    ...body,
    '',
    'Legends Used in Account Statement',
  ]);
}

/** ICICI credit card CSV. */
export function iciciCardCsv(body: string[]) {
  return csv([
    'Accountno:,4315XXXXXXXX2468',
    'Customer Name:,TEST USER',
    '',
    'Date,Sr.No.,Transaction Details,Reward Point Header,Intl.Amount,Amount(in Rs),BillingAmountSign',
    ...body,
  ]);
}
