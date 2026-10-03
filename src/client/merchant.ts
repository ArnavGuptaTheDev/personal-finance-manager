// Merchant names from raw bank descriptions:
//   "UPI-SWIGGY-SWIGGY8@YBL-412398712" → "Swiggy",  "POS 416021XXXXXX1234 BLINKIT" → "Blinkit".
// Pure and DOM-free: the Worker uses it when storing transactions, the browser when importing.

// Payment-rail and bank words that are never part of a merchant name.
const NOISE = new Set([
  'upi', 'pos', 'neft', 'imps', 'rtgs', 'ach', 'nach', 'ecs', 'ecom', 'atm', 'nwd', 'atw', 'cr', 'dr', 'd', 'c', 'txn',
  'trf', 'tfr', 'transfer', 'ref', 'refno', 'inb', 'ib', 'mb', 'mob', 'bil', 'billpay', 'onl', 'vps', 'vin', 'p2a', 'p2m',
  'rev', 'reversal', 'payment', 'paymt', 'pmt', 'from', 'to', 'by', 'via', 'mmt', 'mandate', 'si', 'debit', 'credit',
  'card', 'purchase', 'pur', 'sale', 'emi', 'autopay', 'collect', 'request', 'sent', 'received', 'thank', 'you',
]);
// Legal and place suffixes dropped from the end of a name.
const SUFFIX = new Set(['ltd', 'limited', 'pvt', 'private', 'llp', 'inc', 'india', 'in', 'ind', 'co', 'the']);
const MONTHS = new Set(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec']);

const isReference = (w: string) =>
  /\d{5,}/.test(w) || // reference and account numbers
  /^[a-z]{4}0[a-z0-9]{6}$/i.test(w) || // IFSC codes
  /x{3,}/i.test(w) || // card masks (416021XXXXXX1234)
  /^\d+$/.test(w) ||
  /^\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?$/.test(w); // dates

function words(segment: string): string[] {
  return segment
    .replace(/\(sr:[^)]*\)/gi, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}&]+|[^\p{L}\p{N}&]+$/gu, ''))
    .filter((w) => w && !w.includes('@') && !isReference(w) && !NOISE.has(w.toLowerCase()) && !MONTHS.has(w.toLowerCase()));
}

const titleCase = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

/** A short, readable merchant name, or '' when the description holds none. */
export function normalizeMerchant(description: string): string {
  for (const segment of description.split(/[-/*|:_]+|\s{2,}/)) {
    const kept = words(segment);
    while (kept.length && SUFFIX.has(kept.at(-1)!.toLowerCase())) kept.pop();
    if (!kept.length || kept.join('').length < 2) continue;
    // A lone short word is usually an acronym ("KFC", "HP"); statements are all caps, so only then keep it.
    if (kept.length === 1 && kept[0]!.length <= 3) return kept[0]!.toUpperCase();
    return kept.slice(0, 3).map(titleCase).join(' ').slice(0, 60);
  }
  return '';
}
