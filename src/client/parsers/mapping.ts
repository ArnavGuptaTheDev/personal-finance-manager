// Helpers for mapping an unrecognised statement by hand: guess the header row and
// what each column holds, then turn the choices into a ColumnMapping (header names
// and rules only, never cell content).
import type { AmountRule, ColumnMapping, DateOrder } from './formats';
import { parseDate } from './statement';

export type MappingRole = keyof ColumnMapping['columns'];
export type MappingChoice = { header: number; amounts: AmountRule; dateOrder: DateOrder; columns: Partial<Record<MappingRole, number>> };

const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

const GUESS: [MappingRole, RegExp][] = [
  ['date', /\bdate\b|^dt$/i],
  ['description', /narration|particular|description|details|remark|transaction$/i],
  ['debit', /withdraw|debit(?!.*credit)|\bdr\b(?!.*cr)|paid out|money out/i],
  ['credit', /deposit|credit(?!.*debit)|\bcr\b(?!.*dr)|paid in|money in/i],
  ['amount', /amount|\bamt\b/i],
  ['sign', /cr\s*\/\s*dr|dr\s*\/\s*cr|debit\s*\/\s*credit|\bsign\b|\btype\b/i],
  ['balance', /balance|\bbal\b|running total/i],
];

/** The row just above the first row that starts with a readable date, if it has 3+ titles. */
export function guessHeaderRow(rows: string[][]): number {
  const firstDated = rows.findIndex((r) => r.some((c, i) => i < 3 && parseDate(clean(c)) !== null));
  for (let i = firstDated - 1; i >= 0 && i >= firstDated - 3; i--) {
    if (rows[i]!.filter((c) => clean(c)).length >= 3) return i;
  }
  const wide = rows.findIndex((r) => r.filter((c) => clean(c)).length >= 3);
  return wide >= 0 ? wide : 0;
}

export function guessChoice(rows: string[][]): MappingChoice {
  const header = guessHeaderRow(rows);
  const titles = (rows[header] ?? []).map(clean);
  const columns: MappingChoice['columns'] = {};
  const taken = new Set<number>();
  for (const [role, re] of GUESS) {
    const i = titles.findIndex((t, idx) => t && re.test(t) && !taken.has(idx));
    if (i >= 0) {
      columns[role] = i;
      taken.add(i);
    }
  }
  const split = columns.debit !== undefined || columns.credit !== undefined;
  if (split) delete columns.amount;
  return { header, amounts: split ? 'split' : columns.sign !== undefined ? 'marker' : 'negative-debit', dateOrder: 'dmy', columns };
}

/** Choices (column positions) → a saved-format mapping (column titles). */
export function toMapping(rows: string[][], choice: MappingChoice): ColumnMapping {
  const titles = (rows[choice.header] ?? []).map(clean);
  const columns: ColumnMapping['columns'] = {};
  const wanted: MappingRole[] =
    choice.amounts === 'split' ? ['date', 'description', 'debit', 'credit', 'balance'] : choice.amounts === 'marker' ? ['date', 'description', 'amount', 'sign', 'balance'] : ['date', 'description', 'amount', 'balance'];
  for (const role of wanted) {
    const i = choice.columns[role];
    if (i !== undefined && titles[i]) columns[role] = titles[i];
  }
  return { version: 1, columns, amounts: choice.amounts, dateOrder: choice.dateOrder };
}
