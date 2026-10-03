const inrFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const inrShortFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', notation: 'compact', maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthFmt = new Intl.DateTimeFormat('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });

/** Full precision, for tables and edit forms. */
export const inr = (n: number) => inrFmt.format(n);
/** Compact (₹5.7L), for KPIs and charts. Pair it with a title holding inr(n). */
export const inrShort = (n: number) => inrShortFmt.format(n);
export const signedInr = (amount: number, type: 'debit' | 'credit') => `${type === 'credit' ? '+' : '−'}${inr(amount)}`;

/** Parses a typed amount such as "1,234.50" or "₹ 1234"; NaN if it isn't a positive amount with ≤ 2 decimals. */
export function parseMoney(raw: string): number {
  const s = raw.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return Number.NaN;
  const n = Number(s);
  return n > 0 ? n : Number.NaN;
}

/** An amount as it should appear in an editable money field. */
export const moneyInput = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
export const fmtDate = (iso: string) => dateFmt.format(new Date(`${iso}T00:00:00Z`));
export const fmtMonth = (ym: string) => monthFmt.format(new Date(`${ym}-01T00:00:00Z`));

/** Local calendar date as YYYY-MM-DD. */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addMonths(iso: string, months: number): string {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return d.toISOString().slice(0, 10);
}

/** Preset date ranges for filters. Returns [from, to] or [undefined, undefined] for all time. */
export function rangeFor(preset: string): [string | undefined, string | undefined] {
  const t = today();
  const monthStart = `${t.slice(0, 7)}-01`;
  switch (preset) {
    case 'this-month':
      return [monthStart, t];
    case 'last-month': {
      const start = addMonths(monthStart, -1);
      const end = new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)), 0)).toISOString().slice(0, 10);
      return [start, end];
    }
    case '3-months':
      return [addMonths(monthStart, -2), t];
    case '12-months':
      return [addMonths(monthStart, -11), t];
    case 'this-year':
      return [`${t.slice(0, 4)}-01-01`, t];
    default:
      return [undefined, undefined];
  }
}

export function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}
