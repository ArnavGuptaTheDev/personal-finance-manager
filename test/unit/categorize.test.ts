import { describe, expect, it } from 'vitest';
import { Categorizer, compileRule, prepare } from '../../src/client/categorize';
import type { Category } from '../../src/client/types';

const cat = (id: number, rules: { keyword?: string; regex?: string }[]): Category => ({
  id,
  name: `C${id}`,
  kind: 'expense',
  builtin: false,
  keywords: rules.map((r, i) => ({ id: id * 100 + i, keyword: r.keyword ?? null, regex: r.regex ?? null, builtin: false })),
});

describe('rule matching', () => {
  const descriptions = ['UPI-SWIGGY-SWIGGY8@YBL-412398712', 'POS COLA STORE', 'OLA CABS', 'AMAZONPAY INDIA', 'NEFT CR-ACME SALARY'];

  it('a single rule matches exactly what the categoriser would match with only that rule', () => {
    for (const rule of [{ keyword: 'swiggy' }, { keyword: 'ola' }, { keyword: 'amazon' }, { keyword: 'acme salary' }, { regex: '^pos ' }]) {
      const alone = new Categorizer([cat(1, [rule])]);
      const match = compileRule({ keyword: rule.keyword ?? null, regex: rule.regex ?? null })!;
      for (const d of descriptions) expect(match(d, prepare(d)), `${JSON.stringify(rule)} on ${d}`).toBe(alone.categorize(d) === 1);
    }
  });

  it('short keywords match whole words only', () => {
    const ola = compileRule({ keyword: 'ola', regex: null })!;
    expect(ola('OLA CABS', prepare('OLA CABS'))).toBe(true);
    expect(ola('POS COLA STORE', prepare('POS COLA STORE'))).toBe(false);
  });

  it('rejects an invalid regex instead of throwing', () => {
    expect(compileRule({ keyword: null, regex: '(' })).toBeNull();
  });
});
