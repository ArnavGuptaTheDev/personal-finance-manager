// Assigns a category to a transaction description using keyword/regex rules.
// Runs in the browser, so user-written regexes never execute on the server.
// Order: user regex → built-in regex → user keyword → built-in keyword → fuzzy match.
import type { Category } from './types';

const IGNORED_WORDS = new Set(['upi', 'pos', 'neft', 'imps', 'rtgs', 'ach', 'txn', 'ref', 'payment', 'to', 'from', 'by', 'ltd', 'pvt', 'india']);

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return 1 - prev[b.length]! / Math.max(a.length, b.length);
}

type Rule = { categoryId: number; user: boolean };

export class Categorizer {
  private regexes: (Rule & { re: RegExp })[] = [];
  private keywords: (Rule & { kw: string; words: string[] })[] = [];

  constructor(categories: Category[]) {
    for (const cat of categories) {
      for (const k of cat.keywords) {
        const user = !k.builtin;
        if (k.regex) {
          try {
            this.regexes.push({ categoryId: cat.id, user, re: new RegExp(k.regex, 'i') });
          } catch {
            /* invalid regex: skip */
          }
        } else if (k.keyword) {
          const kw = normalize(k.keyword);
          if (kw) this.keywords.push({ categoryId: cat.id, user, kw, words: kw.split(' ') });
        }
      }
    }
    // User rules first; within each group, longer (more specific) keywords first.
    this.regexes.sort((a, b) => Number(b.user) - Number(a.user));
    this.keywords.sort((a, b) => Number(b.user) - Number(a.user) || b.kw.length - a.kw.length);
  }

  categorize(description: string): number | null {
    for (const r of this.regexes) if (r.re.test(description)) return r.categoryId;

    const text = normalize(description);
    const words = text.split(' ').filter((w) => !IGNORED_WORDS.has(w));
    const padded = ` ${words.join(' ')} `;
    const squashed = words.join('');

    for (const k of this.keywords) {
      // Whole-word match for short keywords ("ola" must not match "cola"),
      // substring match for long ones ("amazon" matches "amazonpay").
      if (padded.includes(` ${k.kw} `)) return k.categoryId;
      if (k.kw.length >= 5 && !k.kw.includes(' ') && squashed.includes(k.kw)) return k.categoryId;
    }

    // Fuzzy: catch typos/truncations like "swigy" or "zomat".
    let best: { id: number; score: number } | null = null;
    for (const k of this.keywords) {
      if (k.words.length !== 1 || k.kw.length < 5) continue;
      for (const w of words) {
        if (w.length < 4) continue;
        const score = similarity(w, k.kw);
        if (score >= 0.8 && (!best || score > best.score)) best = { id: k.categoryId, score };
      }
    }
    return best?.id ?? null;
  }
}
