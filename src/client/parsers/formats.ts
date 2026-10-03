// Statement layouts as pure configuration. To support a new bank, add one entry to
// BUILTIN_FORMATS (plus a synthetic fixture under test/fixtures/statements/).

export type ColumnRole = 'date' | 'description' | 'debit' | 'credit' | 'amount' | 'sign' | 'ref' | 'balance';

/**
 * How a row's amount becomes a debit or credit:
 *  - split:           separate withdrawal (debit) and deposit (credit) columns;
 *  - marker:          one amount column, plus a marker ("Cr") that means credit;
 *  - negative-debit:  one signed amount column, negative = money out;
 *  - negative-credit: one signed amount column, negative = money in (card style).
 */
export type AmountRule = 'split' | 'marker' | 'negative-debit' | 'negative-credit';
export type DateOrder = 'dmy' | 'mdy' | 'ymd';

export type FormatConfig = {
  label: string;
  /** Every pattern must match some cell of the header row (or of two stacked header rows). */
  header: RegExp[];
  /** For each role, aliases tried in order; the first unclaimed matching column wins. */
  columns: Partial<Record<ColumnRole, RegExp[]>>;
  amounts: AmountRule;
  /** marker rule: a sign-column value matching this means credit. */
  creditMarker?: RegExp;
  /** marker rule: "5,000.00 Cr" in the amount cell itself also means credit. */
  markerInAmount?: boolean;
  /** Rows whose description matches are balance carry-overs, not transactions. */
  carryOver?: RegExp;
  /** Appends " (Sr:<ref>)" from the ref column, keeping same-day identical rows apart. */
  appendRef?: boolean;
  /** Patterns whose first group holds the account or card number, searched above the table. */
  accountNumber: RegExp[];
  dateOrder: DateOrder;
};

const ACCOUNT_NO = /(?:account|a\/c)\s*(?:no|number)?\.?\s*[:\-,]?\s*([x*\d][x*\d\s-]*\d)/i;
const CARD_NO = /card\s*(?:no|number)?\.?\s*[:\-,]?\s*([x*\d][x*\d\s-]*\d)/i;

export type BuiltinFormatId = 'hdfc:savings' | 'hdfc:credit_card' | 'icici:savings' | 'icici:credit_card';

export const BUILTIN_FORMATS: Record<BuiltinFormatId, FormatConfig> = {
  'hdfc:savings': {
    label: 'HDFC savings',
    header: [/^date$/, /narration/, /withdrawal/],
    columns: { date: [/^date$/], description: [/narration/], debit: [/withdrawal/], credit: [/deposit/], balance: [/closing balance|^balance/] },
    amounts: 'split',
    carryOver: /^b\/f$/i,
    accountNumber: [/(?:account|a\/c)\s*(?:no|number)\.?\s*[:\-]?\s*([x*\d][x*\d\s-]*\d)/i],
    dateOrder: 'dmy',
  },
  'hdfc:credit_card': {
    label: 'HDFC credit card',
    header: [/date/, /description/, /amt|amount/],
    columns: { date: [/^date/, /date/], description: [/description/], amount: [/amt|amount/], sign: [/debit\s*\/\s*credit|cr\/dr|dr\/cr/] },
    amounts: 'marker',
    creditMarker: /cr/i,
    markerInAmount: true,
    accountNumber: [/card\s*(?:no|number)\.?\s*[:\-]?\s*([x*\d][x*\d\s-]*\d)/i],
    dateOrder: 'dmy',
  },
  'icici:savings': {
    label: 'ICICI savings',
    header: [/date/, /particulars|remarks/, /withdrawal/],
    columns: {
      date: [/^transaction date$/, /^date$/, /date/],
      description: [/particulars/, /transaction remarks/, /remarks/],
      debit: [/withdrawal/],
      credit: [/deposit/],
      balance: [/balance/],
    },
    amounts: 'split',
    carryOver: /^b\/f$/i,
    accountNumber: [ACCOUNT_NO],
    dateOrder: 'dmy',
  },
  'icici:credit_card': {
    label: 'ICICI credit card',
    header: [/^date$/, /transaction details|details/, /amount/],
    columns: {
      date: [/^date$/],
      description: [/transaction details/, /details/],
      amount: [/amount\s*\(in rs\)/, /amount.*rs/, /^amount/],
      sign: [/billingamountsign|sign/],
      ref: [/^sr\.?\s*no/],
    },
    amounts: 'marker',
    creditMarker: /cr/i,
    appendRef: true,
    accountNumber: [/([x*\d]*x{2,}[x*\d\s-]*\d)/i, CARD_NO],
    dateOrder: 'dmy',
  },
};

/**
 * A layout the person mapped by hand. Saved formats store exactly this: header names
 * and rules, never any cell content from the file.
 */
export type ColumnMapping = {
  version: 1;
  columns: Partial<Record<'date' | 'description' | 'amount' | 'debit' | 'credit' | 'sign' | 'balance', string>>;
  amounts: AmountRule;
  dateOrder: DateOrder;
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const normHeader = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** What a mapping needs before it can be used. Null when complete. */
export function mappingProblem(m: ColumnMapping): string | null {
  if (!m.columns.date) return 'Choose the date column';
  if (!m.columns.description) return 'Choose the description column';
  if (m.amounts === 'split' && !m.columns.debit && !m.columns.credit) return 'Choose the debit and credit columns';
  if (m.amounts !== 'split' && !m.columns.amount) return 'Choose the amount column';
  if (m.amounts === 'marker' && !m.columns.sign) return 'Choose the column that marks credits (Cr/Dr)';
  return null;
}

export function mappingToFormat(m: ColumnMapping, label = 'Your format'): FormatConfig {
  const exact = (name: string) => new RegExp(`^${escape(normHeader(name))}$`);
  const columns: FormatConfig['columns'] = {};
  for (const [role, name] of Object.entries(m.columns)) if (name) columns[role as ColumnRole] = [exact(name)];
  return {
    label,
    header: Object.values(m.columns).filter((n): n is string => Boolean(n)).map(exact),
    columns,
    amounts: m.amounts,
    creditMarker: /\bcr\b|credit/i,
    accountNumber: [ACCOUNT_NO, CARD_NO],
    dateOrder: m.dateOrder,
  };
}
